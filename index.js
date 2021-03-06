
const redisType = require("ioredis");
const scripto = require('redis-scripto');
const path = require('path');
const pgp = require('pg-promise')();

const inventory_key = "Inventory";
const default_schema = "public";
pgp.pg.types.setTypeParser(20, BigInt); // This is for serialization bug of BigInts as strings.
const InfinityStampTag = "InfStamp";
const InfinityIdTag = "InfId";
const PrimaryTag = "primary";
let counter = 0;
module.exports = async function (indexerRedisConnectionString, pgReadConfigParams, pgWriteConfigParams) {
    configDBWriter = pgp(pgWriteConfigParams);
    //TODO: Get an advisory lock here.
    await configDBWriter.none(`CREATE TABLE IF NOT EXISTS public."Resources"
    (
        "Id" bigserial,
        "Read" text NOT NULL,
        "Write" text NOT NULL,
        "MaxTables" integer NOT NULL,
        "MaxRows" integer NOT NULL,
        PRIMARY KEY ("Id")
    );
    
    CREATE TABLE IF NOT EXISTS public."Types"
    (
        "Id" bigserial,
        "Def" text[] NOT NULL,
        PRIMARY KEY ("Id")
    );`);
    await configDBWriter.$pool.end();
    return new InfinityTableFactory(indexerRedisConnectionString, pgReadConfigParams, pgWriteConfigParams);
}
class InfinityTableFactory {
    #pgReadConfigParams
    #pgWriteConfigParams
    #indexerRedisConnectionString
    #redisClient
    #scriptingEngine
    #configDBWriter
    #configDBReader

    constructor(indexerRedisConnectionString, pgReadConfigParams, pgWriteConfigParams) {
        this.#pgReadConfigParams = pgReadConfigParams;
        this.#pgWriteConfigParams = pgWriteConfigParams;
        this.#indexerRedisConnectionString = indexerRedisConnectionString;
        this.#redisClient = new redisType(indexerRedisConnectionString);
        this.#scriptingEngine = new scripto(this.#redisClient);
        this.#scriptingEngine.loadFromDir(path.resolve(path.dirname(__filename), 'lua'));
        this.#configDBWriter = pgp(pgWriteConfigParams);
        this.#configDBReader = pgp(pgReadConfigParams);

        this.registerResource = this.registerResource.bind(this);
        this.createTable = this.createTable.bind(this);
        this.loadTable = this.loadTable.bind(this);

        this.codeRed = () => {
            this.#redisClient.disconnect();
            this.#configDBWriter.$pool.end();
            this.#configDBReader.$pool.end();
        };//Not be exposed for PROD
    }


    async registerResource(readerConnectionParams, writerConnectionParams, maxTables, maxRowsPerTable) {
        return await this.#configDBWriter.tx(async (trans) => {
            // creating a sequence of transaction queries:
            let rIdentifier = await trans.one('INSERT INTO "Resources" ("Read","Write","MaxTables","MaxRows") values ($1,$2,$3,$4) RETURNING "Id";', [JSON.stringify(readerConnectionParams), JSON.stringify(writerConnectionParams), maxTables, maxRowsPerTable]);

            let redisRegister = (rId, countOfTables, rowsPerTable) => new Promise((resolve, reject) => this.#scriptingEngine.run('load-resources', [inventory_key], [rId, countOfTables, rowsPerTable], function (err, result) {
                if (err != undefined) {
                    reject(err);
                    return;
                }
                resolve(result)
            }));

            await redisRegister(rIdentifier.Id, maxTables, maxRowsPerTable);
            return rIdentifier.Id;
        });
    }

    async createTable(tableDefinition) {

        const infinityIdColumn = {
            "name": InfinityIdTag,
            "datatype": "bigint",
            "filterable": { "sorted": "asc" },
            "tag": InfinityIdTag
        };
        const infinityStampColumn = {
            "name": InfinityStampTag,
            "datatype": "bigint",
            "filterable": { "sorted": "asc" },
            "tag": InfinityStampTag
        };
        let userDefinedPK = false;
        let userDefinedPKDatatype;
        const totalPrimaryColumns = tableDefinition.reduce((acc, e) => acc + (e.tag === PrimaryTag ? 1 : 0), 0);
        if (totalPrimaryColumns > 1) throw new Error("Table cannot have multiple primary columns");
        if (totalPrimaryColumns === 0) tableDefinition.unshift(infinityIdColumn);
        if (totalPrimaryColumns === 1) {
            console.warn("It is recommended to use system generated infinity id for better scalling and performance.");
            userDefinedPK = true;
            userDefinedPKDatatype = tableDefinition.find(e => e.tag === PrimaryTag)["datatype"];
        }
        const totalInfinityStamoColumns = tableDefinition.reduce((acc, e) => acc + (e.tag === InfinityStampTag ? 1 : 0), 0);
        if (totalInfinityStamoColumns > 1) throw new Error("Table cannot have multiple InfitiyStamp columns");
        if (totalInfinityStamoColumns === 0) tableDefinition.push(infinityStampColumn);
        if (totalInfinityStamoColumns == 1) {
            const infinityStampColumn = tableDefinition.find(e => e.tag === InfinityStampTag);
            if (infinityStampColumn.datatype !== "bigint") throw new Error("InfitiyStamp columns should have datatype as bigint.");
        }

        const tableId = await this.#configDBWriter.tx(async trans => {

            let tIdentifier = await trans.one('INSERT INTO "Types" ("Def") values ($1) RETURNING "Id";', [tableDefinition]);
            if (userDefinedPK) {
                await trans.none(`CREATE TABLE public."${tIdentifier.Id}-PK"
                (
                    "UserPK" ${userDefinedPKDatatype} NOT NULL,
                    "CInfId" text NOT NULL,
                    PRIMARY KEY ("UserPK")
                );`); //THIS table should be partitioned with HASH for 20CR rows
            }
            await trans.none(`CREATE TABLE public."${tIdentifier.Id}-Min"
            (
                "InfStamp" bigint NOT NULL,
                "PInfId" text NOT NULL,
                CONSTRAINT "${tIdentifier.Id}-Min-PK" PRIMARY KEY ("PInfId")
            );`);
            await trans.none(`CREATE TABLE public."${tIdentifier.Id}-Max"
            (
                "InfStamp" bigint NOT NULL,
                "PInfId" text NOT NULL,
                CONSTRAINT "${tIdentifier.Id}-Max-PK" PRIMARY KEY ("PInfId")
            );`);
            return tIdentifier.Id;
        });

        return new InfinityTable(this.#pgReadConfigParams, this.#pgWriteConfigParams, this.#indexerRedisConnectionString, tableId, tableDefinition);
    }

    async loadTable(TableIdentifier) {
        let tableDef = await this.#configDBReader.one('SELECT "Def" FROM "Types" WHERE "Id"=$1', [TableIdentifier]);
        if (tableDef == undefined) {
            throw new Error(`Table with id does ${TableIdentifier} not exists.`);
        }
        tableDef = tableDef.Def.map(e => JSON.parse(e));
        return new InfinityTable(this.#pgReadConfigParams, this.#pgWriteConfigParams, this.#indexerRedisConnectionString, TableIdentifier, tableDef);
    }
}

class InfinityTable {
    #configDBReader
    #configDBWriter
    #def
    #connectionMap
    #redisClient
    #scriptingEngine
    #columnsNames
    #userDefinedPk = false;
    #primaryColumn
    TableIdentifier = -1;

    constructor(configReaderConnectionParams, configWriterConnectionParams, indexerRedisConnectionString, systemTableIdentifier, tableDefinition) {
        this.#configDBReader = pgp(configReaderConnectionParams);
        this.#configDBWriter = pgp(configWriterConnectionParams);
        this.TableIdentifier = systemTableIdentifier;
        this.#def = tableDefinition;
        this.#connectionMap = new Map();
        this.#redisClient = new redisType(indexerRedisConnectionString);
        this.#scriptingEngine = new scripto(this.#redisClient);
        this.#scriptingEngine.loadFromDir(path.resolve(path.dirname(__filename), 'lua'));

        this.datatypes = new Map();
        this.datatypes.set("bigint", "bigint");
        this.datatypes.set("integer", "integer");
        this.datatypes.set("text", "text");
        this.datatypes.set("double", "double precision");
        this.filterOperators = new Map();
        this.filterOperators.set("=", function (name, operands) { return pgp.as.format("$1:name = $2", [name, operands[0]]); });
        this.filterOperators.set("IN", function (name, operands) { return pgp.as.format("$1:name IN $2", [name, operands]); });

        this.#columnsNames = this.#def.map(e => e.name);

        this.#generateIdentity = this.#generateIdentity.bind(this);
        this.#teraformTableSpace = this.#teraformTableSpace.bind(this);
        this.#sqlTransform = this.#sqlTransform.bind(this);
        this.#generateSqlTableColumns = this.#generateSqlTableColumns.bind(this);
        this.#generateSqlIndexColumns = this.#generateSqlIndexColumns.bind(this);
        this.#generatePrimaryKeyConstraintColumns = this.#generatePrimaryKeyConstraintColumns.bind(this);
        this.#indexPrimarykey = this.#indexPrimarykey.bind(this);
        this.#indexInfinityStampMin = this.#indexInfinityStampMin.bind(this);
        this.#indexInfinityStampMax = this.#indexInfinityStampMax.bind(this);
        this.#retriveConnectionForDB = this.#retriveConnectionForDB.bind(this);
        this.#idConstruct = this.#idConstruct.bind(this);

        this.#idParser = this.#idParser;

        this.bulkInsert = this.bulkInsert.bind(this);

        this.#def.forEach(columnDef => {
            if (columnDef.tag === PrimaryTag) {
                this.#userDefinedPk = true;
                this.#primaryColumn = columnDef;
            }
            else if (columnDef.tag === InfinityIdTag) {
                this.#primaryColumn = columnDef;
            }
        });

        //Not be exposed for PROD
        this.codeRed = () => {
            this.#redisClient.disconnect();
            this.#connectionMap.forEach((con, key) => {
                con.$pool.end();
                this.#connectionMap.delete(key);
            });
        };
    }

    #generateIdentity = (range) => {
        return new Promise((resolve, reject) => this.#scriptingEngine.run('identity', [this.TableIdentifier, inventory_key], [range], function (err, result) {
            if (err != undefined) {
                reject(err);
                return;
            }
            if (result[0] == -1) { //Partial failures will be forced into the last table its better than to fail the call.
                reject(new Error("Error: (" + result[0] + ") => " + result[1]))
            }
            result.splice(0, 1);
            resolve(result)
        }))
    }

    #generateSqlTableColumns = (completeSql, schema) => {
        // let schema = {
        //     "name": "value",
        //     "datatype": "bigint|integer|float|json|byte[]",
        //     "filterable": { "sorted": "asc | desc" },
        //     "primary":true,
        //     "key": {
        //         "range":10
        //     }
        // } "TagId" INTEGER NOT NULL,
        if (this.datatypes.has(schema.datatype)) {
            completeSql += pgp.as.format(" $[name:alias] $[datatype:raw],", { "name": schema.name, "datatype": this.datatypes.get(schema.datatype) });
        }
        else {
            throw new Error(`${schema.datatype} is not supported data type.`);
        }
        return completeSql;
    }

    #generateSqlIndexColumns = (completeSql, schema) => {

        if (schema.filterable != undefined) {
            completeSql += pgp.as.format(" $[name:alias] $[sort:raw],", { "name": schema.name, "sort": schema.filterable.sorted === 'asc' ? "ASC" : "DESC" });
        }
        return completeSql;
    }

    #generatePrimaryKeyConstraintColumns = (completeSql, schema) => {
        if (schema.tag === InfinityIdTag || schema.tag === PrimaryTag) {
            completeSql += pgp.as.format("$[name:alias],", schema);
        }
        return completeSql;
    }

    #teraformTableSpace = async (databaseId, tableId) => {

        let currentWriterConnection = await this.#retriveConnectionForDB(databaseId, 'W');

        let tableColumns = this.#def.reduce(this.#generateSqlTableColumns, "");
        let indexColumns = this.#def.reduce(this.#generateSqlIndexColumns, "");
        let primaryKeyColumns = this.#def.reduce(this.#generatePrimaryKeyConstraintColumns, "");
        primaryKeyColumns = primaryKeyColumns.slice(0, -1);
        tableColumns = tableColumns.slice(0, -1);
        indexColumns = indexColumns.slice(0, -1);

        let functionSql = `CREATE OR REPLACE FUNCTION $[schema_name:name].$[function_name:name] (IN name TEXT) RETURNS VOID
        LANGUAGE 'plpgsql'
        AS $$
        DECLARE
        table_name TEXT := $[table_name] || '-' || name;
        index_name TEXT := table_name ||'_idx';
        primarykey_name TEXT := table_name ||'_pk';
        dsql TEXT;
        BEGIN
        dsql:= 'SELECT pg_advisory_lock(hashtext($1)); ';
        dsql:= dsql ||'CREATE TABLE IF NOT EXISTS $[schema_name:name].'|| quote_ident(table_name) || '($[columns:raw] ,CONSTRAINT '|| quote_ident(primarykey_name)||' PRIMARY KEY ($[primaryKeyColumns:raw])); ';
        dsql:= dsql ||'CREATE INDEX IF NOT EXISTS '|| quote_ident(index_name) ||' ON $[schema_name:name].' || quote_ident(table_name) || ' ($[indexColumns:raw]);';
        EXECUTE dsql USING table_name;
        END$$;`;
        await currentWriterConnection.none(pgp.as.format(functionSql, {
            "schema_name": default_schema,
            "function_name": ("infinity_part_" + this.TableIdentifier),
            "table_name": this.TableIdentifier + "-" + databaseId,
            "columns": tableColumns,
            "primaryKeyColumns": primaryKeyColumns,
            "indexColumns": indexColumns
        }));

        await currentWriterConnection.one(`SELECT "${default_schema}"."infinity_part_${this.TableIdentifier}"('${tableId}')`);
        return `${this.TableIdentifier}-${databaseId}-${tableId}`;
    }

    #sqlTransform = (tableName, payload) => {

        let valuesString = payload.reduce((valuesString, element) => valuesString += `(${element.Values.join(",")}),`, "");
        let columns = this.#columnsNames.reduce((acc, e) => acc + `${pgp.as.format('$1:alias', [e])},`, "");
        columns = columns.slice(0, -1);
        valuesString = valuesString.slice(0, -1)
        return `INSERT INTO "${default_schema}"."${tableName}" (${columns}) VALUES ${valuesString} RETURNING *`;
    }

    #indexPrimarykey = (tableName, payload) => {

        let valuesString = payload.reduce((valuesString, element) => valuesString += pgp.as.format("($1,$2),", [element.UserPk, element.InfinityRowId]), "");
        valuesString = valuesString.slice(0, -1)
        return `INSERT INTO "${default_schema}"."${tableName}" ("UserPK","CInfId") VALUES ${valuesString};`;
    }

    #indexInfinityStampMin = (tableName, payload, PInfId) => {

        let min = payload.reduce((min, element) => Math.min(min, element.InfinityStamp), Number.MAX_VALUE);
        return `INSERT INTO "${default_schema}"."${tableName}" ("InfStamp","PInfId") VALUES (${min},'${PInfId}') ON CONFLICT ON CONSTRAINT "${tableName + "-PK"}"
        DO UPDATE SET "InfStamp" = LEAST(EXCLUDED."InfStamp","${tableName}"."InfStamp")`;
    }

    #indexInfinityStampMax = (tableName, payload, PInfId) => {

        let max = payload.reduce((max, element) => Math.max(max, element.InfinityStamp), Number.MIN_VALUE);
        return `INSERT INTO "${default_schema}"."${tableName}" ("InfStamp","PInfId") VALUES (${max},'${PInfId}') ON CONFLICT ON CONSTRAINT "${tableName + "-PK"}"
        DO UPDATE SET "InfStamp" = GREATEST(EXCLUDED."InfStamp","${tableName}"."InfStamp")`;
    }

    async bulkInsert(payload) {
        //This code has run away complexity dont trip on it ;)
        if (payload.length > 10000) throw new Error("Currently ingestion rate of 10K/sec is only supported!");

        console.time("Identity");
        let identities = await this.#generateIdentity(payload.length);
        console.timeEnd("Identity");

        console.time("Transform");
        let lastChange = null;
        let groupedPayloads = payload.reduceRight((groups, value, idx) => {
            idx = idx + 1;
            let changeIdx = identities.findIndex(e => e[0] == idx);
            if (changeIdx == -1 && lastChange == null) throw new Error("Did not find start index");
            if (changeIdx != -1) {
                lastChange = identities.splice(changeIdx, 1)[0];
            }
            let dbId = lastChange[1];
            let tableId = lastChange[2];
            let scopedRowId = lastChange[3];
            let completeRowId = `${this.TableIdentifier}-${dbId}-${tableId}-${scopedRowId}`;
            lastChange[3]++;
            let item = { "InfinityRowId": completeRowId, "Values": [], "InfinityStamp": counter };
            counter++;
            //let item = { "InfinityRowId": completeRowId, "Values": [], "InfinityStamp": Date.now() };

            this.#def.forEach(columnDef => {
                let colValue = value[columnDef.name];
                if (colValue == undefined) {
                    if (columnDef.tag === PrimaryTag) throw new Error("Primary field cannot be null:" + columnDef.name);//This should be done before to save identities
                    if (columnDef.tag === InfinityIdTag) colValue = scopedRowId;
                    if (columnDef.tag === InfinityStampTag) colValue = item.InfinityStamp;
                }
                else {
                    if (columnDef.tag === PrimaryTag) {
                        item["UserPk"] = colValue;
                    }
                    if (columnDef.tag === InfinityStampTag) item.InfinityStamp = colValue;
                }
                item.Values.push(colValue);
            });

            let dbgroup = groups.get(dbId);
            if (dbgroup == undefined) {
                let temp = new Map();
                temp.set(tableId, [item]);
                groups.set(dbId, temp);
            }
            else {
                let tablegroup = dbgroup.get(tableId);
                if (tablegroup == undefined) {
                    dbgroup.set(tableId, [item]);
                }
                else {
                    tablegroup.push(item);
                }
            }
            return groups;
        }, new Map());
        console.timeEnd("Transform");

        console.time("PG");
        let results = { "failures": [], "success": [] };
        let DBIds = Array.from(groupedPayloads.keys());
        for (let dbIdx = 0; dbIdx < DBIds.length; dbIdx++) {
            const dbId = DBIds[dbIdx];
            const tables = groupedPayloads.get(dbId);
            const tableIds = Array.from(tables.keys());
            for (let tableIdx = 0; tableIdx < tableIds.length; tableIdx++) {
                const tableId = tableIds[tableIdx];
                const items = tables.get(tableId);
                try {
                    const tableName = await this.#teraformTableSpace(dbId, tableId);
                    const DBWritter = await this.#retriveConnectionForDB(dbId, 'W');
                    const insertedRows = await DBWritter.tx(async instanceTrans => {
                        //TODO: Validate with redis as wwell
                        await this.#configDBWriter.tx(async indexTran => {
                            if (this.#userDefinedPk) {
                                let sql = this.#indexPrimarykey((this.TableIdentifier + "-PK"), items);
                                await indexTran.none(sql);
                            }
                            let sql = this.#indexInfinityStampMin((this.TableIdentifier + "-Min"), items, tableName);
                            await indexTran.none(sql);
                            sql = this.#indexInfinityStampMax((this.TableIdentifier + "-Max"), items, tableName);
                            await indexTran.none(sql);
                        });

                        let sql = this.#sqlTransform(tableName, items);
                        return instanceTrans.any(sql);
                    });
                    results.success.push(insertedRows.map(e => {
                        e.InfId = tableName + "-" + e.InfId;
                        return e;
                    }));
                }
                catch (err) {
                    results.failures.push({ "Error": err, "Items": items });
                    continue;
                    //TODO: Reclaim Lost Ids
                }
            }
        }
        console.timeEnd("PG");
        return results;
    }

    #idParser = (completeInfId) => {
        let parts = completeInfId.split("-");
        return {
            "Type": parseInt(parts[0]),
            "DBId": parseInt(parts[1]),
            "TableNo": parseInt(parts[2]),
            "Row": parseInt(parts[3])
        }
    }

    #idConstruct = (databaseId, tableNumber, rowNumber) => {
        return `${this.TableIdentifier}-${databaseId}-${tableNumber}${rowNumber != undefined ? ('-' + rowNumber) : ''}`;
    }

    #retriveConnectionForDB = async (databaseId, readerWriter = 'R') => {
        if (this.#connectionMap.has(databaseId) == false) {
            let conDetails = await this.#configDBReader.one('SELECT "Read","Write" FROM "Resources" WHERE "Id"=$1', [databaseId]);
            let tableDBWriter = pgp(JSON.parse(conDetails["Write"]));
            let tableDBReader = pgp(JSON.parse(conDetails["Read"]));
            this.#connectionMap.set(databaseId, { "W": tableDBWriter, "R": tableDBReader });
        }
        return this.#connectionMap.get(databaseId)[readerWriter];
    }

    async retrive(ids) {
        let results = { "results": [], "page": [] };
        let disintegratedIds;

        if (this.#userDefinedPk) {
            disintegratedIds = await this.#configDBReader.any('SELECT "UserPK" AS "ActualId", split_part("CInfId",$3,1)::Int as "Type",split_part("CInfId",$3,2)::Int as "DBId",split_part("CInfId",$3,3)::Int as "TableNo", "UserPK" as "Row" FROM $1:name WHERE "UserPK" = ANY ($2)', [(this.TableIdentifier + '-PK'), ids, '-']);
        }
        else {
            disintegratedIds = ids.map((id) => {
                let verifyId = this.#idParser(id);
                if (verifyId.Type !== this.TableIdentifier) throw new Error("Incorrect Id:" + id + " doesnot belong to this table.");
                verifyId.ActualId = id;
                return verifyId
            });
        }

        let groupedIds = disintegratedIds.reduce((acc, e) => {
            if (acc.has(e.DBId)) {
                let tablesMap = acc.get(e.DBId);
                if (tablesMap.has(e.TableNo)) {
                    tablesMap.get(e.TableNo).push({ "Row": e.Row, "ActualId": e.ActualId });
                }
                else {
                    tablesMap.set(e.TableNo, [{ "Row": e.Row, "ActualId": e.ActualId }]);
                }
            }
            else {
                let tableMap = new Map();
                tableMap.set(e.TableNo, [{ "Row": e.Row, "ActualId": e.ActualId }]);
                acc.set(e.DBId, tableMap);
            }
            return acc;
        }, new Map());

        let DBIds = Array.from(groupedIds.keys())
        for (let dbIdx = 0; dbIdx < DBIds.length; dbIdx++) {
            const dbId = DBIds[dbIdx];
            const tables = groupedIds.get(dbId);
            const tableIds = Array.from(tables.keys());
            for (let tableIdx = 0; tableIdx < tableIds.length; tableIdx++) {
                const DBReader = await this.#retriveConnectionForDB(dbId);
                const currentTable = tableIds[tableIdx];
                const currentTableIds = tables.get(currentTable);
                const onlyIds = currentTableIds.map(e => e.Row);
                //TODO There is a case where table doesnt exists as the DB/Table went rouge/missing.
                let data = await DBReader.any("SELECT * FROM $1:name WHERE $2:name = ANY ($3)", [this.#idConstruct(dbId, currentTable), this.#primaryColumn.name, onlyIds]);
                for (let index = 0; index < data.length; index++) {
                    const acquiredObject = data[index];
                    let acquiredId = acquiredObject[this.#primaryColumn.name];
                    if (this.#userDefinedPk === false) {
                        acquiredId = this.#idConstruct(dbId, currentTable, acquiredId);
                        acquiredObject[InfinityIdTag] = acquiredId;
                    }
                    let spliceIdx = ids.indexOf(acquiredId);
                    if (spliceIdx === -1) throw new Error("Database returned extra id:" + acquiredId);
                    ids.splice(spliceIdx, 1);
                }
                results.results = data;
                results.page = ids;
                return results;
            }
        }
        return results;
    }

    async search(start, end, filter, pages = []) {
        // "filter": {
        //     "conditions": [
        //         {
        //             "name": "severity",
        //             "operator": "=",
        //             "values": [
        //                 1
        //             ]
        //         }
        //     ],
        //     "combine": "$1:raw OR $2:raw"
        // }
        let results = { "results": [], "pages": [] };
        let pageSql;
        if (pages == undefined || pages.length === 0) {
            if (start != undefined && end != undefined) {
                pageSql = pgp.as.format(`SELECT "Min"."InfStamp" as "Start", "Max"."InfStamp" as "End",
                split_part("Max"."PInfId",$1,1)::Int as "Type",
                split_part("Max"."PInfId",$1,2)::Int as "DBId",
                split_part("Max"."PInfId",$1,3)::Int as "TableNo",
                "Max"."PInfId" as "Page"
                FROM $4:name as "Max" JOIN $5:name as "Min" ON "Max"."PInfId"="Min"."PInfId"
                WHERE $2 < "Max"."InfStamp" AND  $3 > "Min"."InfStamp"
                ORDER BY "Min"."InfStamp"`, ['-', start, end, (this.TableIdentifier + "-Max"), (this.TableIdentifier + "-Min")]);
            }
            else {
                pageSql = pgp.as.format(`SELECT "Min"."InfStamp" as "Start", "Max"."InfStamp" as "End",
                split_part("Max"."PInfId",$1,1)::Int as "Type",
                split_part("Max"."PInfId",$1,2)::Int as "DBId",
                split_part("Max"."PInfId",$1,3)::Int as "TableNo",
                "Max"."PInfId" as "Page"
                FROM $4:name as "Max" JOIN $5:name as "Min" ON "Max"."PInfId"="Min"."PInfId"
                ORDER BY "Min"."InfStamp"`, ['-', start, end, (this.TableIdentifier + "-Max"), (this.TableIdentifier + "-Min")]);
            }
        }
        else {
            pageSql = pgp.as.format(`SELECT "Min"."InfStamp" as "Start", "Max"."InfStamp" as "End",
            split_part("Max"."PInfId",$1,1)::Int as "Type",
            split_part("Max"."PInfId",$1,2)::Int as "DBId",
            split_part("Max"."PInfId",$1,3)::Int as "TableNo",
            "Max"."PInfId" as "Page"
            FROM $2:name as "Max" JOIN $3:name as "Min" ON "Max"."PInfId"="Min"."PInfId"
            WHERE "Max"."PInfId" = ANY ($4)
            ORDER BY "Min"."InfStamp"`, ['-', (this.TableIdentifier + "-Max"), (this.TableIdentifier + "-Min"), pages]);

        }
        pages = await this.#configDBReader.any(pageSql);
        if (pages.length > 0) {
            let searchPage = pages.shift();
            results.pages = pages.map(e => ({ "page": e.Page, "start": e.Start, "end": e.End }));
            let where = "";
            if (filter !== undefined) {
                let conditions = filter.conditions.map(c => {
                    if (this.#columnsNames.indexOf(c.name) === -1) {
                        throw new Error(`Field ${c.name} is not a part of this table.`);
                    }
                    if (this.filterOperators.has(c.operator) == false) {
                        throw new Error(`Operator ${c.operator} not supported.`);
                    }
                    return this.filterOperators.get(c.operator)(c.name, c.values);
                });
                where = pgp.as.format(filter.combine, conditions);
            }
            let searchQuery;
            if (where == undefined || where === "") {
                searchQuery = pgp.as.format("SELECT * FROM $1:name", [this.#idConstruct(searchPage.DBId, searchPage.TableNo)])
            }
            else {
                searchQuery = pgp.as.format("SELECT * FROM $1:name WHERE $2:raw", [this.#idConstruct(searchPage.DBId, searchPage.TableNo), where]);
            }
            const DBReader = await this.#retriveConnectionForDB(searchPage.DBId);
            results.results = await DBReader.any(searchQuery);
            if (this.#userDefinedPk) {
                results.results = results.results.map(e => {
                    e[InfinityIdTag] = this.#idConstruct(searchPage.DBId, searchPage.TableNo, e[InfinityIdTag]);
                    return e;
                });
            }
        }

        return results;
    }

    bulkUpdate() {

    }

    bulkDelete() {

    }
}

//TODO:
//Handle Empty data from sql when no data is returned for query
//Handle No DB id existing for Get call No Table Existing for get call No row existing for get call