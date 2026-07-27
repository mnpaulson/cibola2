const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile, saveBase64Image } = require('../utils/image');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');

// Helper to get job details loaded (nested customer, employee, images)
async function getJobWithDetails(jobId) {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (job) {
        job.job_images = await db.prepare('SELECT id, job_id, note, image, created_at, updated_at FROM images WHERE job_id = ?').all(jobId);
        job.customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(job.customer_id) || null;
        job.employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(job.employee_id) || null;
    }
    return job || null;
}

// 1. GET /jobs (List all, recent, customer-specific, or paginated)
router.get('/', async (req, res) => {
    try {
        const { recent, customer_id, page, limit, sortBy, descending } = req.query;

        // A. Recent jobs list
        if (recent === 'true') {
            const rows = await db.prepare(`
                SELECT j.*, 
                       c.fname AS customer_fname, c.lname AS customer_lname, c.phone AS customer_phone, c.email AS customer_email,
                       e.name AS employee_name, e.active AS employee_active
                FROM jobs j
                LEFT JOIN customers c ON j.customer_id = c.id
                LEFT JOIN employees e ON j.employee_id = e.id
                ORDER BY j.updated_at DESC
                LIMIT 13
            `).all();

            const jobs = rows.map(row => ({
                ...row,
                job_images: [],
                customer: row.customer_id ? {
                    id: row.customer_id,
                    fname: row.customer_fname,
                    lname: row.customer_lname,
                    phone: row.customer_phone,
                    email: row.customer_email
                } : null,
                employee: row.employee_id ? {
                    id: row.employee_id,
                    name: row.employee_name,
                    active: row.employee_active
                } : null
            }));
            return sendSuccess(res, jobs);
        }

        // B. Customer specific jobs
        if (customer_id) {
            const rows = await db.prepare(`
                SELECT j.*, 
                       c.fname AS customer_fname, c.lname AS customer_lname, c.phone AS customer_phone, c.email AS customer_email,
                       e.name AS employee_name, e.active AS employee_active
                FROM jobs j
                LEFT JOIN customers c ON j.customer_id = c.id
                LEFT JOIN employees e ON j.employee_id = e.id
                WHERE j.customer_id = ?
            `).all(customer_id);

            const jobs = rows.map(row => ({
                ...row,
                job_images: [],
                customer: row.customer_id ? {
                    id: row.customer_id,
                    fname: row.customer_fname,
                    lname: row.customer_lname,
                    phone: row.customer_phone,
                    email: row.customer_email
                } : null,
                employee: row.employee_id ? {
                    id: row.employee_id,
                    name: row.employee_name,
                    active: row.employee_active
                } : null
            }));
            return sendSuccess(res, jobs);
        }

        // C. Paginated & Sorted jobs
        if (page) {
            const sortColumn = sortBy || 'created_at';
            const sortDirection = descending === 'true' ? 'DESC' : 'ASC';
            const parsedLimit = parseInt(limit) || 10;
            const currentPage = parseInt(page) || 1;
            const offset = (currentPage - 1) * parsedLimit;

            const totalRecord = await db.prepare('SELECT COUNT(*) as count FROM jobs').get();
            const total = totalRecord ? totalRecord.count : 0;
            const lastPage = Math.ceil(total / parsedLimit) || 1;

            const allowedColumns = ['id', 'customer_id', 'employee_id', 'estimate', 'due_date', 'completed_at', 'created_at', 'updated_at'];
            const validatedSortCol = allowedColumns.includes(sortColumn) ? sortColumn : 'created_at';

            const rows = await db.prepare(`
                SELECT j.*, 
                       c.fname AS customer_fname, c.lname AS customer_lname, c.phone AS customer_phone, c.email AS customer_email,
                       e.name AS employee_name, e.active AS employee_active
                FROM jobs j
                LEFT JOIN customers c ON j.customer_id = c.id
                LEFT JOIN employees e ON j.employee_id = e.id
                ORDER BY j.${validatedSortCol} ${sortDirection}
                LIMIT ? OFFSET ?
            `).all(parsedLimit, offset);

            const jobs = rows.map(row => ({
                ...row,
                job_images: [],
                customer: row.customer_id ? {
                    id: row.customer_id,
                    fname: row.customer_fname,
                    lname: row.customer_lname,
                    phone: row.customer_phone,
                    email: row.customer_email
                } : null,
                employee: row.employee_id ? {
                    id: row.employee_id,
                    name: row.employee_name,
                    active: row.employee_active
                } : null
            }));

            return sendPaginated(res, jobs, {
                currentPage,
                lastPage,
                perPage: parsedLimit,
                total
            });
        }

        // D. Simple non-paginated listing of all jobs
        const rows = await db.prepare(`
            SELECT j.*, 
                   c.fname AS customer_fname, c.lname AS customer_lname, c.phone AS customer_phone, c.email AS customer_email,
                   e.name AS employee_name, e.active AS employee_active
            FROM jobs j
            LEFT JOIN customers c ON j.customer_id = c.id
            LEFT JOIN employees e ON j.employee_id = e.id
        `).all();

        const jobs = rows.map(row => ({
            ...row,
            job_images: [],
            customer: row.customer_id ? {
                id: row.customer_id,
                fname: row.customer_fname,
                lname: row.customer_lname,
                phone: row.customer_phone,
                email: row.customer_email
            } : null,
            employee: row.employee_id ? {
                id: row.employee_id,
                name: row.employee_name,
                active: row.employee_active
            } : null
        }));
        return sendSuccess(res, jobs);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /jobs/stats (Monthly aggregate totals)
router.get('/stats', async (req, res) => {
    try {
        const stats = {
            monthTotals: [],
            monthNames: [],
            monthJobs: []
        };

        const today = new Date();
        const monthNamesList = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        for (let i = 0; i < 12; i++) {
            const targetDate = new Date(today.getFullYear(), today.getMonth() - i, 1);
            const targetYear = targetDate.getFullYear();
            const targetMonthStr = String(targetDate.getMonth() + 1).padStart(2, '0');

            const dateClause = db.isMySQL 
                ? "DATE_FORMAT(created_at, '%Y-%m') = ?"
                : "strftime('%Y-%m', created_at) = ?";

            const monthTotalRecord = await db.prepare(`
                SELECT SUM(estimate) as total, COUNT(*) as count
                FROM jobs
                WHERE ${dateClause}
            `).get(`${targetYear}-${targetMonthStr}`);

            const total = monthTotalRecord && monthTotalRecord.total ? parseFloat(monthTotalRecord.total) : 0;
            const count = monthTotalRecord && monthTotalRecord.count ? parseInt(monthTotalRecord.count) : 0;

            stats.monthTotals.push(total);
            stats.monthNames.push(monthNamesList[targetDate.getMonth()]);
            stats.monthJobs.push(count);
        }

        stats.monthTotals.reverse();
        stats.monthNames.reverse();
        stats.monthJobs.reverse();

        return sendSuccess(res, stats);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 3. GET /jobs/:id (Show single job details)
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const job = await getJobWithDetails(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }
        return sendSuccess(res, job);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. POST /jobs (Create a job)
router.post('/', async (req, res) => {
    try {
        const { customer_id, employee_id, estimate, deposit, est_note, note, appraisal, vital_date, due_date, completed_at, job_images } = req.body;
        const timestamp = getTimestamp();

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        let parsedEstimate = 0;
        if (estimate) {
            parsedEstimate = parseFloat(String(estimate).replace(/,/g, '')) || 0;
        }

        const insertJob = db.prepare(`
            INSERT INTO jobs (customer_id, employee_id, estimate, deposit, est_note, note, appraisal, vital_date, due_date, completed_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = await insertJob.run(
            customer_id,
            employee_id || 1,
            parsedEstimate,
            deposit !== undefined && deposit !== null ? parseFloat(deposit) : null,
            est_note || null,
            note || null,
            appraisal ? 1 : 0,
            vital_date ? 1 : 0,
            due_date || null,
            completed_at || null,
            timestamp,
            timestamp
        );

        const jobId = result.lastInsertRowid;

        // Save uploaded job images
        if (Array.isArray(job_images) && job_images.length > 0) {
            const maxImageRecord = await db.prepare('SELECT MAX(id) as maxId FROM images').get();
            let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

            const insertImage = db.prepare(`
                INSERT INTO images (job_id, note, image, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const img of job_images) {
                if (img.image) {
                    const savedPath = saveBase64Image(img.image, 'job', jobId, nextImageId);
                    await insertImage.run(jobId, img.note || null, savedPath, timestamp, timestamp);
                    nextImageId++;
                }
            }
        }

        const newJob = await getJobWithDetails(jobId);
        return sendSuccess(res, newJob, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. PUT /jobs/:id (Update a job)
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { customer_id, employee_id, estimate, deposit, est_note, note, appraisal, vital_date, due_date, completed_at, job_images } = req.body;
        const timestamp = getTimestamp();

        // Check if job exists
        const existingJob = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
        if (!existingJob) {
            return sendError(res, 'Job not found', 404);
        }

        if (!customer_id || parseInt(customer_id) === 0) {
            return sendError(res, 'Customer cannot be blank', 400);
        }

        let parsedEstimate = 0;
        if (estimate) {
            parsedEstimate = parseFloat(String(estimate).replace(/,/g, '')) || 0;
        }

        // Update Job info
        const updateJob = db.prepare(`
            UPDATE jobs
            SET customer_id = ?, employee_id = ?, estimate = ?, deposit = ?, est_note = ?, note = ?, appraisal = ?, vital_date = ?, due_date = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
        `);
        await updateJob.run(
            customer_id,
            employee_id || 1,
            parsedEstimate,
            deposit !== undefined && deposit !== null ? parseFloat(deposit) : null,
            est_note || null,
            note || null,
            appraisal ? 1 : 0,
            vital_date ? 1 : 0,
            due_date || null,
            completed_at || null,
            timestamp,
            id
        );

        // Save/Update images
        if (Array.isArray(job_images) && job_images.length > 0) {
            const maxImageRecord = await db.prepare('SELECT MAX(id) as maxId FROM images').get();
            let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

            const insertImage = db.prepare(`
                INSERT INTO images (job_id, note, image, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            const updateImageNote = db.prepare(`
                UPDATE images
                SET note = ?, updated_at = ?
                WHERE id = ?
            `);

            for (const img of job_images) {
                if (img.id) {
                    // Update note for existing image
                    await updateImageNote.run(img.note || '', timestamp, img.id);
                } else if (img.image) {
                    // Save new Base64 image
                    const savedPath = saveBase64Image(img.image, 'job', id, nextImageId);
                    await insertImage.run(id, img.note || null, savedPath, timestamp, timestamp);
                    nextImageId++;
                }
            }
        }

        const updatedJob = await getJobWithDetails(id);
        return sendSuccess(res, updatedJob);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 6. DELETE /jobs/:id (Delete job and clean related files)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }

        // Fetch and delete associated job image files
        const images = await db.prepare('SELECT image FROM images WHERE job_id = ?').all(id);
        for (const img of images) {
            deleteImageFile(img.image);
        }

        const transaction = db.transaction(async () => {
            // Delete job images from database
            await db.prepare('DELETE FROM images WHERE job_id = ?').run(id);
            // Delete job from database
            await db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
        });

        await transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 7. POST /jobs/:id/complete (Complete a job)
router.post('/:id/complete', async (req, res) => {
    try {
        const { id } = req.params;
        
        const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }

        const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const timestamp = getTimestamp();

        await db.prepare('UPDATE jobs SET completed_at = ?, updated_at = ? WHERE id = ?').run(dateStr, timestamp, id);
        
        const updatedJob = await getJobWithDetails(id);
        return sendSuccess(res, updatedJob);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 8. POST /jobs/:id/uncomplete (Uncomplete a job)
router.post('/:id/uncomplete', async (req, res) => {
    try {
        const { id } = req.params;

        const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }

        const timestamp = getTimestamp();

        await db.prepare('UPDATE jobs SET completed_at = NULL, updated_at = ? WHERE id = ?').run(timestamp, id);
        
        const updatedJob = await getJobWithDetails(id);
        return sendSuccess(res, updatedJob);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 9. DELETE /jobs/images/:id (Delete specific job image by ID)
router.delete('/images/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const image = await db.prepare('SELECT * FROM images WHERE id = ? AND job_id IS NOT NULL').get(id);
        
        if (image) {
            deleteImageFile(image.image);
            await db.prepare('DELETE FROM images WHERE id = ?').run(id);
            return sendSuccess(res, { id: parseInt(id), image: image.image });
        } else {
            return sendError(res, 'Image not found', 404);
        }
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
