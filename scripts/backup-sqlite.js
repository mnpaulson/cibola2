const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Retention period in days
const RETENTION_DAYS = 30;

function getFormattedTimestamp() {
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${YYYY}-${MM}-${DD}_${hh}-${mm}-${ss}`;
}

function logMessage(logFilePath, message) {
    const logEntry = `[${new Date().toISOString()}] ${message}\n`;
    console.log(message);
    try {
        fs.appendFileSync(logFilePath, logEntry, 'utf8');
    } catch (err) {
        console.error('Failed to write to log file:', err.message);
    }
}

async function performBackup() {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../database.sqlite');
    const backupsDir = process.env.BACKUP_DIR || process.env.BACKUP_PATH || path.join(__dirname, '../backups');
    const logFilePath = path.join(backupsDir, 'backup.log');

    // Ensure backups directory exists
    if (!fs.existsSync(backupsDir)) {
        fs.mkdirSync(backupsDir, { recursive: true });
    }

    logMessage(logFilePath, '====================================================');
    logMessage(logFilePath, ' Starting Automated SQLite Database Backup');
    logMessage(logFilePath, '====================================================');

    if (!fs.existsSync(dbPath)) {
        logMessage(logFilePath, `[ERROR] Source database file not found at: ${dbPath}`);
        process.exit(1);
    }

    const timestamp = getFormattedTimestamp();
    const backupFileName = `database_backup_${timestamp}.sqlite`;
    const backupFilePath = path.join(backupsDir, backupFileName);

    logMessage(logFilePath, `Source DB Path: ${dbPath}`);
    logMessage(logFilePath, `Target Backup Path: ${backupFilePath}`);

    try {
        const db = new Database(dbPath, { readonly: true });
        
        // better-sqlite3 native hot backup API
        await db.backup(backupFilePath);
        db.close();

        const stats = fs.statSync(backupFilePath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        logMessage(logFilePath, `[SUCCESS] Database backup completed successfully! File size: ${fileSizeMB} MB`);
    } catch (err) {
        logMessage(logFilePath, `[ERROR] Backup failed: ${err.message}`);
        process.exit(1);
    }

    // Clean up old backups
    try {
        logMessage(logFilePath, `Checking for old backups (> ${RETENTION_DAYS} days)...`);
        const files = fs.readdirSync(backupsDir);
        const nowTime = Date.now();
        const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
        let deletedCount = 0;

        for (const file of files) {
            if (file.startsWith('database_backup_') && file.endsWith('.sqlite')) {
                const filePath = path.join(backupsDir, file);
                const fileStats = fs.statSync(filePath);
                if (nowTime - fileStats.mtimeMs > maxAgeMs) {
                    fs.unlinkSync(filePath);
                    logMessage(logFilePath, `[CLEANUP] Deleted old backup: ${file}`);
                    deletedCount++;
                }
            }
        }
        if (deletedCount === 0) {
            logMessage(logFilePath, 'No old backups needed cleanup.');
        }
    } catch (cleanupErr) {
        logMessage(logFilePath, `[WARNING] Error during backup cleanup: ${cleanupErr.message}`);
    }

    logMessage(logFilePath, 'Backup process finished.\n');
}

performBackup();
