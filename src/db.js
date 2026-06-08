const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '../database.sqlite');

// Ensure parent directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath, { verbose: console.log });

// Enable foreign keys
db.pragma('foreign_keys = ON');

function getTimestamp() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Initialize schema
function initSchema() {
    db.exec(`
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

        CREATE TABLE IF NOT EXISTS job_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            note TEXT,
            image TEXT NOT NULL,
            created_at DATETIME,
            updated_at DATETIME,
            FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
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

        CREATE TABLE IF NOT EXISTS credit_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goldcredit_id INTEGER NOT NULL,
            note TEXT,
            image TEXT NOT NULL,
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
            pricePer REAL NOT NULL DEFAULT 0,
            created_at DATETIME,
            updated_at DATETIME,
            FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE
        );
    `);
}

// Seed initial lookup tables
function seedInitialData() {
    const timestamp = getTimestamp();

    // Check if employees table is empty
    const empCount = db.prepare('SELECT COUNT(*) as count FROM employees').get().count;
    if (empCount === 0) {
        console.log('Seeding employees...');
        const insertEmp = db.prepare('INSERT INTO employees (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
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
        const transaction = db.transaction((list) => {
            for (const emp of list) {
                insertEmp.run(emp.id, emp.name, emp.active, timestamp, timestamp);
            }
        });
        transaction(employeesList);
    }

    // Check if values table is empty
    const valCount = db.prepare('SELECT COUNT(*) as count FROM "values"').get().count;
    if (valCount === 0) {
        console.log('Seeding values...');
        const insertVal = db.prepare('INSERT INTO "values" (type_id, name, value1, value2, value3, value4, "order", active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const valuesList = [
            { type_id: 1, name: '8k', value1: '0.333', value2: '0.6', value3: 'Gold', value4: null, order: '1', active: 1 },
            { type_id: 1, name: '9k', value1: '0.375', value2: '0.6', value3: 'Gold', value4: null, order: '2', active: 1 },
            { type_id: 1, name: '10k', value1: '0.417', value2: '0.6', value3: 'Gold', value4: null, order: '3', active: 1 },
            { type_id: 1, name: '12k', value1: '0.5', value2: '0.6', value3: 'Gold', value4: null, order: '4', active: 1 },
            { type_id: 1, name: '14k', value1: '0.585', value2: '0.6', value3: 'Gold', value4: null, order: '5', active: 1 },
            { type_id: 1, name: '18k', value1: '0.75', value2: '0.6', value3: 'Gold', value4: null, order: '6', active: 1 },
            { type_id: 1, name: '20k', value1: '0.833', value2: '0.6', value3: 'Gold', value4: null, order: '7', active: 1 },
            { type_id: 1, name: '22k', value1: '0.916', value2: '0.6', value3: 'Gold', value4: null, order: '8', active: 1 },
            { type_id: 1, name: '24k', value1: '1', value2: '0.75', value3: 'Gold', value4: null, order: '9', active: 1 },
            { type_id: 1, name: 'Diamonds', value1: '300', value2: '1', value3: 'Other', value4: null, order: '10', active: 1 },
            { type_id: 1, name: 'Platinum', value1: '0.95', value2: '0.4', value3: 'Platinum', value4: null, order: '11', active: 1 },
            { type_id: 1, name: 'Other', value1: '5', value2: '1', value3: 'Other', value4: null, order: '12', active: 1 },
            { type_id: 2, name: 'GoldCAD', value1: '0', value2: null, value3: null, value4: null, order: '13', active: 1 },
            { type_id: 2, name: 'PlatCAD', value1: '0', value2: null, value3: null, value4: null, order: '14', active: 1 }
        ];
        const transaction = db.transaction((list) => {
            for (const val of list) {
                insertVal.run(val.type_id, val.name, val.value1, val.value2, val.value3, val.value4, val.order, val.active, timestamp, timestamp);
            }
        });
        transaction(valuesList);
    }
}

initSchema();
seedInitialData();

module.exports = {
    db,
    getTimestamp
};
