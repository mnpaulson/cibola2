const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Initialize DB schema & seeds on import
require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../public');

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Enable CORS
app.use(cors());

// Parse JSON request bodies (up to 50MB for Base64 image payloads)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve uploaded images statically
app.use('/storage', express.static(uploadDir));

// Import routes
const customerRoutes = require('./routes/customers');
const employeeRoutes = require('./routes/employees');
const jobRoutes = require('./routes/jobs');
const valueRoutes = require('./routes/values');
const creditRoutes = require('./routes/credits');
const customSheetRoutes = require('./routes/customSheets');

// Mount routes
app.use('/customers', customerRoutes);
app.use('/employees', employeeRoutes);
app.use('/jobs', jobRoutes);
app.use('/values', valueRoutes);
app.use('/goldcredits', creditRoutes);
app.use('/customsheets', customSheetRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`Jewelry Sale & Repair Store Backend running!`);
    console.log(`Local LAN Access Port: ${PORT}`);
    console.log(`SQLite DB Path: ${process.env.DB_PATH || 'database.sqlite'}`);
    console.log(`Image Uploads folder: ${uploadDir}`);
    console.log(`===============================================`);
});
