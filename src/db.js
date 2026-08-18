const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

const connectionType = process.env.DB_CONNECTION || 'sqlite';
let db;

function getTimestamp() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

if (connectionType === 'mysql') {
    const host = process.env.DB_HOST || '127.0.0.1';
    const port = parseInt(process.env.DB_PORT) || 3306;
    const database = process.env.DB_DATABASE || 'cibola';
    const user = process.env.DB_USERNAME || 'root';
    const password = process.env.DB_PASSWORD || '';

    const transactionStorage = new AsyncLocalStorage();

    class MySQLWrapper {
        constructor() {
            this.pool = mysql.createPool({
                host,
                port,
                user,
                password,
                database,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
                dateStrings: true
            });

            // Set ANSI_QUOTES mode on connection so double-quoted table/column names behave like SQLite
            this.pool.on('connection', (connection) => {
                connection.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')");
            });

            this.isMySQL = true;
        }

        async executeQuery(sql, params, type) {
            const txConnection = transactionStorage.getStore();
            const conn = txConnection || this.pool;

            const [rows] = await conn.execute(sql, params);

            if (type === 'all') {
                return rows; // In mysql2, select query returns an array of objects
            } else if (type === 'get') {
                return rows[0] || null; // returns first row or null
            } else if (type === 'run') {
                return {
                    changes: rows.affectedRows !== undefined ? rows.affectedRows : 0,
                    lastInsertRowid: rows.insertId !== undefined ? rows.insertId : null
                };
            }
        }

        prepare(sql) {
            return {
                all: async (...params) => this.executeQuery(sql, params, 'all'),
                get: async (...params) => this.executeQuery(sql, params, 'get'),
                run: async (...params) => this.executeQuery(sql, params, 'run')
            };
        }

        transaction(fn) {
            return async (...args) => {
                const connection = await this.pool.getConnection();
                try {
                    await connection.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')");
                    await connection.beginTransaction();

                    const result = await transactionStorage.run(connection, async () => {
                        return await fn(...args);
                    });

                    await connection.commit();
                    return result;
                } catch (err) {
                    await connection.rollback();
                    throw err;
                } finally {
                    connection.release();
                }
            };
        }
    }

    db = new MySQLWrapper();
    console.log(`Connected to MySQL database: ${database} on ${host}:${port}`);
} else {
    // SQLite mode
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../database.sqlite');

    // Ensure parent directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const rawDb = new Database(dbPath, { verbose: console.log });
    rawDb.pragma('foreign_keys = ON');

    // Initialize schema
    function initSchema() {
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fname TEXT NOT NULL,
                lname TEXT NOT NULL,
                phone TEXT,
                email TEXT,
                addr_st TEXT,
                addr_city TEXT,
                addr_prov TEXT,
                addr_postal TEXT,
                addr_country TEXT,
                note TEXT,
                created_at DATETIME,
                updated_at DATETIME
            );

            CREATE TABLE IF NOT EXISTS employees (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME,
                updated_at DATETIME
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                employee_id INTEGER NOT NULL DEFAULT 1,
                estimate REAL NOT NULL DEFAULT 0,
                est_note TEXT,
                note TEXT,
                appraisal INTEGER NOT NULL DEFAULT 0,
                vital_date INTEGER NOT NULL DEFAULT 0,
                due_date TEXT,
                completed_at TEXT,
                deposit REAL,
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                FOREIGN KEY (employee_id) REFERENCES employees(id)
            );

            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER,
                goldcredit_id INTEGER,
                custom_sheet_id INTEGER,
                note TEXT,
                image TEXT NOT NULL,
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
                FOREIGN KEY (goldcredit_id) REFERENCES goldcredits(id) ON DELETE CASCADE,
                FOREIGN KEY (custom_sheet_id) REFERENCES custom_sheets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS goldcredits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                employee_id INTEGER NOT NULL DEFAULT 1,
                gold_cad REAL NOT NULL,
                plat_cad REAL NOT NULL,
                gold_date TEXT NOT NULL,
                note TEXT,
                used INTEGER NOT NULL DEFAULT 0,
                credit_type TEXT NOT NULL DEFAULT 'credit',
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                FOREIGN KEY (employee_id) REFERENCES employees(id)
            );

            CREATE TABLE IF NOT EXISTS credit_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                goldcredit_id INTEGER NOT NULL,
                itemId INTEGER NOT NULL,
                markup REAL NOT NULL,
                multiplier REAL NOT NULL,
                value REAL NOT NULL,
                weight REAL NOT NULL,
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (goldcredit_id) REFERENCES goldcredits(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS "values" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                value1 TEXT,
                value2 TEXT,
                value3 TEXT,
                value4 TEXT,
                "order" TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                markup TEXT,
                "default" TEXT,
                created_at DATETIME,
                updated_at DATETIME
            );

            CREATE TABLE IF NOT EXISTS custom_sheets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                note TEXT,
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS estimates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                custom_sheet_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                note TEXT,
                isPrimary INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (custom_sheet_id) REFERENCES custom_sheets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS est_values (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                estimate_id INTEGER NOT NULL,
                name TEXT NOT NULL DEFAULT 'unknown',
                type TEXT NOT NULL,
                priceType TEXT,
                amt REAL NOT NULL DEFAULT 0,
                basePrice REAL NOT NULL DEFAULT 0,
                markup REAL NOT NULL DEFAULT 0,
                discount REAL NOT NULL DEFAULT 0,
                priceModifier REAL NOT NULL DEFAULT 0,
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS customer_duplicates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id_1 INTEGER NOT NULL,
                customer_id_2 INTEGER NOT NULL,
                similarity_score REAL NOT NULL,
                match_reasons TEXT,
                status TEXT NOT NULL DEFAULT 'unreviewed',
                created_at DATETIME,
                updated_at DATETIME,
                FOREIGN KEY (customer_id_1) REFERENCES customers(id) ON DELETE CASCADE,
                FOREIGN KEY (customer_id_2) REFERENCES customers(id) ON DELETE CASCADE,
                UNIQUE (customer_id_1, customer_id_2)
            );
            CREATE INDEX IF NOT EXISTS idx_cust_dup_pair ON customer_duplicates(customer_id_1, customer_id_2);
            CREATE INDEX IF NOT EXISTS idx_cust_dup_status ON customer_duplicates(status);
        `);
    }

    function seedInitialData() {
        const timestamp = getTimestamp();

        const empCount = rawDb.prepare('SELECT COUNT(*) as count FROM employees').get().count;
        if (empCount === 0) {
            console.log('Seeding employees...');
            const insertEmp = rawDb.prepare('INSERT INTO employees (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
            const employeesList = [
                { id: 1, name: 'Unassigned', active: 1 },
                { id: 2, name: 'Graham', active: 1 },
                { id: 3, name: 'Amanda', active: 1 },
                { id: 4, name: 'Elliot', active: 1 },
                { id: 5, name: 'Carley', active: 1 },
                { id: 6, name: 'Jill', active: 1 },
                { id: 7, name: 'Kesley', active: 1 },
                { id: 8, name: 'Mike', active: 1 },
                { id: 9, name: 'Dave', active: 0 }
            ];
            const transaction = rawDb.transaction((list) => {
                for (const emp of list) {
                    insertEmp.run(emp.id, emp.name, emp.active, timestamp, timestamp);
                }
            });
            transaction(employeesList);
        }

        const valCount = rawDb.prepare('SELECT COUNT(*) as count FROM "values"').get().count;
        if (valCount === 0) {
            console.log('Seeding values...');
            const insertVal = rawDb.prepare('INSERT INTO "values" (type_id, name, value1, value2, value3, "order", active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const valuesList = [
                { type_id: 1, name: '8k', value1: '0.333', value2: '0.6', value3: 'Gold', order: '1', active: 1 },
                { type_id: 1, name: '9k', value1: '0.375', value2: '0.6', value3: 'Gold', order: '2', active: 1 },
                { type_id: 1, name: '10k', value1: '0.417', value2: '0.6', value3: 'Gold', order: '3', active: 1 },
                { type_id: 1, name: '12k', value1: '0.5', value2: '0.6', value3: 'Gold', order: '4', active: 1 },
                { type_id: 1, name: '14k', value1: '0.585', value2: '0.6', value3: 'Gold', order: '5', active: 1 },
                { type_id: 1, name: '18k', value1: '0.75', value2: '0.6', value3: 'Gold', order: '6', active: 1 },
                { type_id: 1, name: '20k', value1: '0.833', value2: '0.6', value3: 'Gold', order: '7', active: 1 },
                { type_id: 1, name: '22k', value1: '0.916', value2: '0.6', value3: 'Gold', order: '8', active: 1 },
                { type_id: 1, name: '24k', value1: '1', value2: '0.75', value3: 'Gold', order: '9', active: 1 },
                { type_id: 1, name: 'Diamonds', value1: '300', value2: '1', value3: 'Other', order: '10', active: 1 },
                { type_id: 1, name: 'Platinum', value1: '0.95', value2: '0.4', value3: 'Platinum', order: '11', active: 1 },
                { type_id: 1, name: 'Other', value1: '5', value2: '1', value3: 'Other', order: '12', active: 1 },
                { type_id: 2, name: 'GoldCAD', value1: '0', value2: null, value3: null, order: '13', active: 1 },
                { type_id: 2, name: 'PlatCAD', value1: '0', value2: null, value3: null, order: '14', active: 1 },
                { type_id: 2, name: 'SilverCAD', value1: '0', value2: null, value3: null, order: '15', active: 1 },
                { type_id: 4, name: 'CAD Design', value1: null, value2: null, value3: null, order: '0', active: 1 },
                { type_id: 4, name: 'Metal', value1: null, value2: null, value3: null, order: '1', active: 1 },
                { type_id: 4, name: '2026 New Metal', value1: null, value2: null, value3: null, order: '2', active: 1 },
                { type_id: 4, name: 'New Metal', value1: null, value2: null, value3: null, order: '3', active: 1 },
                { type_id: 4, name: 'Labor', value1: null, value2: null, value3: null, order: '4', active: 1 },
                { type_id: 4, name: 'Setting', value1: null, value2: null, value3: null, order: '5', active: 1 },
                { type_id: 4, name: 'Stones', value1: null, value2: null, value3: null, order: '6', active: 1 },
                { type_id: 4, name: 'Extras', value1: null, value2: null, value3: null, order: '7', active: 1 },
                { type_id: 4, name: 'Earring Parts', value1: null, value2: null, value3: null, order: '8', active: 1 }
            ];
            const transaction = rawDb.transaction((list) => {
                for (const val of list) {
                    insertVal.run(val.type_id, val.name, val.value1, val.value2, val.value3, val.order, val.active, timestamp, timestamp);
                }
            });
            transaction(valuesList);
        }
    }

    initSchema();

    try {
        const tableCheck = rawDb.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name IN ('job_images', 'credit_images', 'custom_images')").get();
        if (tableCheck && tableCheck.count > 0) {
            console.log('[Migration] Consolidating legacy image tables into unified images table...');
            const hasJobImages = rawDb.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='job_images'").get().count > 0;
            const hasCreditImages = rawDb.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='credit_images'").get().count > 0;
            const hasCustomImages = rawDb.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='custom_images'").get().count > 0;

            if (hasJobImages) {
                rawDb.exec(`INSERT INTO images (id, job_id, goldcredit_id, custom_sheet_id, note, image, created_at, updated_at) SELECT id, job_id, NULL, NULL, note, image, created_at, updated_at FROM job_images;`);
                rawDb.exec(`DROP TABLE IF EXISTS job_images;`);
            }
            if (hasCreditImages) {
                rawDb.exec(`INSERT INTO images (id, job_id, goldcredit_id, custom_sheet_id, note, image, created_at, updated_at) SELECT id, NULL, goldcredit_id, NULL, note, image, created_at, updated_at FROM credit_images;`);
                rawDb.exec(`DROP TABLE IF EXISTS credit_images;`);
            }
            if (hasCustomImages) {
                rawDb.exec(`INSERT INTO images (id, job_id, goldcredit_id, custom_sheet_id, note, image, created_at, updated_at) SELECT id, NULL, NULL, custom_sheet_id, note, image, created_at, updated_at FROM custom_images;`);
                rawDb.exec(`DROP TABLE IF EXISTS custom_images;`);
            }
            console.log('[Migration] Legacy image tables migrated to images table.');
        }
    } catch (err) {
        console.error('[Migration] Error migrating legacy image tables:', err.message);
    }

    try {
        rawDb.prepare('ALTER TABLE "values" ADD COLUMN markup TEXT').run();
        console.log('[Migration] Added markup column to values');
    } catch (err) {
        // Already exists
    }

    try {
        rawDb.prepare('ALTER TABLE "values" ADD COLUMN "default" TEXT').run();
        console.log('[Migration] Added default column to values');
    } catch (err) {
        // Already exists
    }

    try {
        rawDb.prepare('ALTER TABLE "values" ADD COLUMN value4 TEXT').run();
        console.log('[Migration] Added value4 column to values');
    } catch (err) {
        // Already exists
    }

    try {
        rawDb.prepare('ALTER TABLE est_values ADD COLUMN basePrice REAL NOT NULL DEFAULT 0').run();
        console.log('[Migration] Added basePrice column to est_values');
    } catch (err) {
        // Already exists
    }

    try {
        rawDb.prepare('ALTER TABLE est_values ADD COLUMN markup REAL NOT NULL DEFAULT 0').run();
        console.log('[Migration] Added markup column to est_values');
    } catch (err) {
        // Already exists
    }

    try {
        rawDb.prepare('ALTER TABLE est_values ADD COLUMN discount REAL NOT NULL DEFAULT 0').run();
        console.log('[Migration] Added discount column to est_values');
    } catch (err) {
        // Already exists
    }

    try {
        rawDb.prepare('ALTER TABLE est_values ADD COLUMN priceModifier REAL NOT NULL DEFAULT 0').run();
        console.log('[Migration] Added priceModifier column to est_values');
    } catch (err) {
        // Already exists
    }

    try {
        const catCount = rawDb.prepare('SELECT COUNT(*) as count FROM "values" WHERE type_id = 4').get().count;
        if (catCount === 0) {
            console.log('[Migration] Seeding default custom sheet categories...');
            const insertVal = rawDb.prepare('INSERT INTO "values" (type_id, name, value1, value2, value3, "order", active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const timestamp = getTimestamp();
            const categoriesList = [
                { type_id: 4, name: 'CAD Design', order: '0' },
                { type_id: 4, name: 'Metal', order: '1' },
                { type_id: 4, name: '2026 New Metal', order: '2' },
                { type_id: 4, name: 'New Metal', order: '3' },
                { type_id: 4, name: 'Labor', order: '4' },
                { type_id: 4, name: 'Setting', order: '5' },
                { type_id: 4, name: 'Stones', order: '6' },
                { type_id: 4, name: 'Extras', order: '7' },
                { type_id: 4, name: 'Earring Parts', order: '8' }
            ];
            const transaction = rawDb.transaction((list) => {
                for (const cat of list) {
                    insertVal.run(cat.type_id, cat.name, null, null, null, cat.order, 1, timestamp, timestamp);
                }
            });
            transaction(categoriesList);
        }
    } catch (err) {
        console.error('[Migration] Failed to seed default custom sheet categories:', err);
    }

    seedInitialData();

    class SQLiteWrapper {
        constructor() {
            this.db = rawDb;
            this.isMySQL = false;
        }

        prepare(sql) {
            const stmt = this.db.prepare(sql);
            return {
                all: async (...params) => stmt.all(...params),
                get: async (...params) => stmt.get(...params),
                run: async (...params) => {
                    const res = stmt.run(...params);
                    return {
                        changes: res.changes,
                        lastInsertRowid: res.lastInsertRowid
                    };
                }
            };
        }

        transaction(fn) {
            return async (...args) => {
                this.db.exec('BEGIN TRANSACTION');
                try {
                    const result = await fn(...args);
                    this.db.exec('COMMIT');
                    return result;
                } catch (err) {
                    try {
                        this.db.exec('ROLLBACK');
                    } catch (rollbackErr) {
                        // ignore
                    }
                    throw err;
                }
            };
        }
    }

    db = new SQLiteWrapper();
    console.log(`Initialized SQLite database at: ${dbPath}`);
}

module.exports = {
    db,
    getTimestamp
};
