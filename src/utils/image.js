const fs = require('fs');
const path = require('path');

/**
 * Delete an image file safely from the upload directory
 * @param {string} imagePath The DB-stored URL path (e.g. '/storage/job1-3.png')
 */
function deleteImageFile(imagePath) {
    if (!imagePath || imagePath.startsWith('http')) return;
    try {
        const filename = path.basename(imagePath);
        const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../public');
        const filepath = path.join(uploadDir, filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            console.log(`Deleted file: ${filepath}`);
        }
    } catch (err) {
        console.error(`Failed to delete file ${imagePath}:`, err);
    }
}

/**
 * Save a Base64-encoded image string to disk.
 * @param {string} base64Str The Base64 string payload
 * @param {string} prefix File prefix (e.g., 'job' or 'credit')
 * @param {number|string} recordId The primary record ID (e.g., job ID or credit ID)
 * @param {number|string} nextImageId The suffix sequence ID
 * @returns {string} The relative storage path suitable for DB storage
 */
function saveBase64Image(base64Str, prefix, recordId, nextImageId) {
    const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../public');
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Extract the raw base64 data (strip off prefix like data:image/png;base64,)
    const commaIndex = base64Str.indexOf(',');
    const base64Data = commaIndex !== -1 ? base64Str.substring(commaIndex + 1) : base64Str;
    const filename = `${prefix}${recordId}-${nextImageId}.png`;
    const filepath = path.join(uploadDir, filename);

    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
    console.log(`Wrote image file: ${filepath}`);

    // Return the URL path stored in DB
    return `/storage/${filename}`;
}

module.exports = {
    deleteImageFile,
    saveBase64Image
};
