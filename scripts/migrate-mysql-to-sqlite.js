const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ============================================================================
// CONFIGURATION (EDITABLE DIRECTORY PATHS & SETTINGS)
// ============================================================================
// Source physical directory where MySQL server uploaded images are stored
const SOURCE_IMAGE_DIR = process.env.SOURCE_IMAGE_DIR || process.env.UPLOAD_DIR || path.join(__dirname, '../public');

// Target physical directory where SQLite app will store/read uploaded images
const TARGET_IMAGE_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../public');

// Target SQLite DB file path
const SQLITE_DB_PATH = process.env.DB_PATH || path.join(__dirname, '../database.sqlite');

// MySQL Connection Details
const MYSQL_CONFIG = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'cibola',
    dateStrings: true
};
// ============================================================================

function getTimestamp() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function migrate() {
    console.log('====================================================');
    console.log(' Starting MySQL to SQLite Database & Image Migration');
    console.log('====================================================');
    console.log(`Source MySQL DB: ${MYSQL_CONFIG.database} on ${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}`);
    console.log(`Target SQLite DB: ${SQLITE_DB_PATH}`);
    console.log(`Source Image Dir: ${SOURCE_IMAGE_DIR}`);
    console.log(`Target Image Dir: ${TARGET_IMAGE_DIR}`);
    console.log('----------------------------------------------------');

    // Ensure target image directory exists
    if (!fs.existsSync(TARGET_IMAGE_DIR)) {
        fs.mkdirSync(TARGET_IMAGE_DIR, { recursive: true });
    }

    // Ensure SQLite target directory exists
    const sqliteDir = path.dirname(SQLITE_DB_PATH);
    if (!fs.existsSync(sqliteDir)) {
        fs.mkdirSync(sqliteDir, { recursive: true });
    }

    // Connect to MySQL
    let mysqlConn;
    try {
        mysqlConn = await mysql.createConnection(MYSQL_CONFIG);
        console.log('Successfully connected to MySQL database.');
    } catch (err) {
        console.error('Failed to connect to MySQL database:', err.message);
        process.exit(1);
    }

    // Initialize SQLite DB (temporarily disable foreign keys during bulk import)
    const sqliteDb = new Database(SQLITE_DB_PATH);
    sqliteDb.pragma('foreign_keys = OFF');

    // Initialize unified SQLite schema
    sqliteDb.exec(`
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
    `);

    console.log('SQLite schema initialized.');

    // Helper for table migration
    const stats = {};

    // 1. Employees
    const [employees] = await mysqlConn.execute('SELECT * FROM employees');
    const insertEmp = sqliteDb.prepare('INSERT OR REPLACE INTO employees (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of employees) {
            insertEmp.run(row.id, row.name, row.active, row.created_at, row.updated_at);
        }
    })();
    stats.employees = employees.length;

    // 2. Customers
    const [customers] = await mysqlConn.execute('SELECT * FROM customers');
    const insertCust = sqliteDb.prepare('INSERT OR REPLACE INTO customers (id, fname, lname, phone, email, addr_st, addr_city, addr_prov, addr_postal, addr_country, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of customers) {
            insertCust.run(row.id, row.fname, row.lname, row.phone, row.email, row.addr_st, row.addr_city, row.addr_prov, row.addr_postal, row.addr_country, row.note, row.created_at, row.updated_at);
        }
    })();
    stats.customers = customers.length;

    // 3. Jobs
    const [jobs] = await mysqlConn.execute('SELECT * FROM jobs');
    const insertJob = sqliteDb.prepare('INSERT OR REPLACE INTO jobs (id, customer_id, employee_id, estimate, est_note, note, appraisal, vital_date, due_date, completed_at, deposit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of jobs) {
            insertJob.run(row.id, row.customer_id, row.employee_id || 1, row.estimate || 0, row.est_note, row.note, row.appraisal || 0, row.vital_date || 0, row.due_date, row.completed_at, row.deposit, row.created_at, row.updated_at);
        }
    })();
    stats.jobs = jobs.length;

    // 4. GoldCredits
    const [goldcredits] = await mysqlConn.execute('SELECT * FROM goldcredits');
    const insertCredit = sqliteDb.prepare('INSERT OR REPLACE INTO goldcredits (id, customer_id, employee_id, gold_cad, plat_cad, gold_date, note, used, credit_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of goldcredits) {
            insertCredit.run(row.id, row.customer_id, row.employee_id || 1, row.gold_cad || row.goldCAD || 0, row.plat_cad || row.platCAD || 0, row.gold_date || row.metalPriceDate || getTimestamp(), row.note, row.used || 0, row.credit_type || 'credit', row.created_at, row.updated_at);
        }
    })();
    stats.goldcredits = goldcredits.length;

    // 5. Credit Items
    const [creditItems] = await mysqlConn.execute('SELECT * FROM credit_items');
    const insertCreditItem = sqliteDb.prepare('INSERT OR REPLACE INTO credit_items (id, goldcredit_id, itemId, markup, multiplier, value, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of creditItems) {
            insertCreditItem.run(row.id, row.goldcredit_id, row.itemId, row.markup, row.multiplier, row.value, row.weight, row.created_at, row.updated_at);
        }
    })();
    stats.credit_items = creditItems.length;

    // 6. Values
    const [values] = await mysqlConn.execute('SELECT * FROM `values`');
    const insertValue = sqliteDb.prepare('INSERT OR REPLACE INTO "values" (id, type_id, name, value1, value2, value3, "order", active, markup, "default", created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of values) {
            insertValue.run(row.id, row.type_id, row.name, row.value1, row.value2, row.value3, row.order, row.active !== undefined ? row.active : 1, row.markup || null, row.default || null, row.created_at, row.updated_at);
        }
    })();
    stats.values = values.length;

    // 7. Custom Sheets
    const [customSheets] = await mysqlConn.execute('SELECT * FROM custom_sheets');
    const insertSheet = sqliteDb.prepare('INSERT OR REPLACE INTO custom_sheets (id, customer_id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of customSheets) {
            insertSheet.run(row.id, row.customer_id, row.name, row.note, row.created_at, row.updated_at);
        }
    })();
    stats.custom_sheets = customSheets.length;

    // 8. Estimates
    const [estimates] = await mysqlConn.execute('SELECT * FROM estimates');
    const insertEstimate = sqliteDb.prepare('INSERT OR REPLACE INTO estimates (id, custom_sheet_id, name, note, isPrimary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of estimates) {
            insertEstimate.run(row.id, row.custom_sheet_id, row.name, row.note, row.isPrimary || 0, row.created_at, row.updated_at);
        }
    })();
    stats.estimates = estimates.length;

    // 9. Est Values
    const [estValues] = await mysqlConn.execute('SELECT * FROM est_values');
    const insertEstValue = sqliteDb.prepare('INSERT OR REPLACE INTO est_values (id, estimate_id, name, type, priceType, amt, basePrice, markup, discount, priceModifier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    sqliteDb.transaction(() => {
        for (const row of estValues) {
            insertEstValue.run(row.id, row.estimate_id, row.name || 'unknown', row.type, row.priceType, row.amt || 0, row.basePrice || 0, row.markup || 0, row.discount || 0, row.priceModifier || 0, row.created_at, row.updated_at);
        }
    })();
    stats.est_values = estValues.length;

    // 10. Images Migration & Physical File Copying
    let imageCopiedCount = 0;
    const insertImage = sqliteDb.prepare('INSERT OR REPLACE INTO images (id, job_id, goldcredit_id, custom_sheet_id, note, image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    // Helper to process and normalize an image record
    const processImageRow = (row, jobId, creditId, sheetId) => {
        let rawImagePath = row.image || '';
        let filename = path.basename(rawImagePath);

        // Normalize DB image path string format to /storage/filename.ext
        let normalizedDbPath = `/storage/${filename}`;

        // Handle physical file migration
        if (filename) {
            const srcFile = path.join(SOURCE_IMAGE_DIR, filename);
            const targetFile = path.join(TARGET_IMAGE_DIR, filename);

            if (fs.existsSync(srcFile) && !fs.existsSync(targetFile)) {
                try {
                    fs.copyFileSync(srcFile, targetFile);
                    imageCopiedCount++;
                } catch (copyErr) {
                    console.warn(`[Warning] Could not copy image file ${filename}:`, copyErr.message);
                }
            }
        }

        insertImage.run(
            row.id || null,
            jobId,
            creditId,
            sheetId,
            row.note || null,
            normalizedDbPath,
            row.created_at || getTimestamp(),
            row.updated_at || getTimestamp()
        );
    };

    let totalJobImages = 0;
    let totalCreditImages = 0;
    let totalCustomImages = 0;

    // Job Images
    try {
        const [jobImages] = await mysqlConn.execute('SELECT * FROM job_images');
        totalJobImages = jobImages.length;
        sqliteDb.transaction(() => {
            for (const img of jobImages) {
                processImageRow(img, img.job_id, null, null);
            }
        })();
    } catch (err) {
        console.warn('[Note] MySQL job_images table query warning:', err.message);
    }

    // Credit Images
    try {
        const [creditImages] = await mysqlConn.execute('SELECT * FROM credit_images');
        totalCreditImages = creditImages.length;
        sqliteDb.transaction(() => {
            for (const img of creditImages) {
                processImageRow(img, null, img.goldcredit_id, null);
            }
        })();
    } catch (err) {
        console.warn('[Note] MySQL credit_images table query warning:', err.message);
    }

    // Custom Images
    try {
        const [customImages] = await mysqlConn.execute('SELECT * FROM custom_images');
        totalCustomImages = customImages.length;
        sqliteDb.transaction(() => {
            for (const img of customImages) {
                processImageRow(img, null, null, img.custom_sheet_id);
            }
        })();
    } catch (err) {
        console.warn('[Note] MySQL custom_images table query warning:', err.message);
    }

    stats.unified_images = totalJobImages + totalCreditImages + totalCustomImages;
    stats.physical_images_copied = imageCopiedCount;

    sqliteDb.pragma('foreign_keys = ON');
    await mysqlConn.end();

    console.log('----------------------------------------------------');
    console.log(' Migration Complete Summary');
    console.log('----------------------------------------------------');
    console.table(stats);
    console.log('====================================================');
    console.log('Successfully migrated data to SQLite DB!');
    console.log('To activate SQLite mode, set DB_CONNECTION=sqlite in .env');
    console.log('====================================================');
}

migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
