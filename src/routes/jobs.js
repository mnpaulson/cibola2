const express = require('express');
const router = express.Router();
const { db, getTimestamp } = require('../db');
const { deleteImageFile, saveBase64Image } = require('../utils/image');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');

// Helper to get job details loaded (nested customer, employee, images)
function getJobWithDetails(jobId) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (job) {
        job.job_images = db.prepare('SELECT * FROM job_images WHERE job_id = ?').all(jobId);
        job.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(job.customer_id) || null;
        job.employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(job.employee_id) || null;
    }
    return job || null;
}

// 1. GET /jobs (List all, recent, customer-specific, or paginated)
router.get('/', (req, res) => {
    try {
        const { recent, customer_id, page, limit, sortBy, descending } = req.query;

        // A. Recent jobs list
        if (recent === 'true') {
            const jobs = db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 13').all();
            for (const job of jobs) {
                job.job_images = db.prepare('SELECT * FROM job_images WHERE job_id = ?').all(job.id);
                job.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(job.customer_id) || null;
                job.employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(job.employee_id) || null;
            }
            return sendSuccess(res, jobs);
        }

        // B. Customer specific jobs
        if (customer_id) {
            const jobs = db.prepare('SELECT * FROM jobs WHERE customer_id = ?').all(customer_id);
            for (const job of jobs) {
                job.job_images = db.prepare('SELECT * FROM job_images WHERE job_id = ?').all(job.id);
            }
            return sendSuccess(res, jobs);
        }

        // C. Paginated & Sorted jobs
        if (page) {
            const sortColumn = sortBy || 'created_at';
            const sortDirection = descending === 'true' ? 'DESC' : 'ASC';
            const parsedLimit = parseInt(limit) || 10;
            const currentPage = parseInt(page) || 1;
            const offset = (currentPage - 1) * parsedLimit;

            const totalRecord = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
            const total = totalRecord ? totalRecord.count : 0;
            const lastPage = Math.ceil(total / parsedLimit) || 1;

            const allowedColumns = ['id', 'customer_id', 'employee_id', 'estimate', 'due_date', 'completed_at', 'created_at', 'updated_at'];
            const validatedSortCol = allowedColumns.includes(sortColumn) ? sortColumn : 'created_at';

            const jobs = db.prepare(`
                SELECT * FROM jobs
                ORDER BY ${validatedSortCol} ${sortDirection}
                LIMIT ? OFFSET ?
            `).all(parsedLimit, offset);

            for (const job of jobs) {
                job.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(job.customer_id) || null;
                job.employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(job.employee_id) || null;
                job.job_images = db.prepare('SELECT * FROM job_images WHERE job_id = ?').all(job.id);
            }

            return sendPaginated(res, jobs, {
                currentPage,
                lastPage,
                perPage: parsedLimit,
                total
            });
        }

        // D. Simple non-paginated listing of all jobs
        const jobs = db.prepare('SELECT * FROM jobs').all();
        for (const job of jobs) {
            job.job_images = db.prepare('SELECT * FROM job_images WHERE job_id = ?').all(job.id);
            job.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(job.customer_id) || null;
            job.employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(job.employee_id) || null;
        }
        return sendSuccess(res, jobs);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 2. GET /jobs/stats (Monthly aggregate totals)
router.get('/stats', (req, res) => {
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

            const monthTotalRecord = db.prepare(`
                SELECT SUM(estimate) as total, COUNT(*) as count
                FROM jobs
                WHERE strftime('%Y-%m', created_at) = ?
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
router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const job = getJobWithDetails(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }
        return sendSuccess(res, job);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 4. POST /jobs (Create a job)
router.post('/', (req, res) => {
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

        const result = insertJob.run(
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
            const maxImageRecord = db.prepare('SELECT MAX(id) as maxId FROM job_images').get();
            let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

            const insertImage = db.prepare(`
                INSERT INTO job_images (job_id, note, image, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const img of job_images) {
                if (img.image) {
                    const savedPath = saveBase64Image(img.image, 'job', jobId, nextImageId);
                    insertImage.run(jobId, img.note || null, savedPath, timestamp, timestamp);
                    nextImageId++;
                }
            }
        }

        const newJob = getJobWithDetails(jobId);
        return sendSuccess(res, newJob, 201);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 5. PUT /jobs/:id (Update a job)
router.put('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { customer_id, employee_id, estimate, deposit, est_note, note, appraisal, vital_date, due_date, completed_at, job_images } = req.body;
        const timestamp = getTimestamp();

        // Check if job exists
        const existingJob = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
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
        updateJob.run(
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
            const maxImageRecord = db.prepare('SELECT MAX(id) as maxId FROM job_images').get();
            let nextImageId = (maxImageRecord && maxImageRecord.maxId ? maxImageRecord.maxId : 0) + 1;

            const insertImage = db.prepare(`
                INSERT INTO job_images (job_id, note, image, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            const updateImageNote = db.prepare(`
                UPDATE job_images
                SET note = ?, updated_at = ?
                WHERE id = ?
            `);

            for (const img of job_images) {
                if (img.id) {
                    // Update note for existing image
                    updateImageNote.run(img.note || '', timestamp, img.id);
                } else if (img.image) {
                    // Save new Base64 image
                    const savedPath = saveBase64Image(img.image, 'job', id, nextImageId);
                    insertImage.run(id, img.note || null, savedPath, timestamp, timestamp);
                    nextImageId++;
                }
            }
        }

        const updatedJob = getJobWithDetails(id);
        return sendSuccess(res, updatedJob);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 6. DELETE /jobs/:id (Delete job and clean related files)
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;

        const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }

        // Fetch and delete associated job image files
        const images = db.prepare('SELECT image FROM job_images WHERE job_id = ?').all(id);
        for (const img of images) {
            deleteImageFile(img.image);
        }

        const transaction = db.transaction(() => {
            // Delete job images from database
            db.prepare('DELETE FROM job_images WHERE job_id = ?').run(id);
            // Delete job from database
            db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
        });

        transaction();
        return sendSuccess(res, { id: parseInt(id) });
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 7. POST /jobs/:id/complete (Complete a job)
router.post('/:id/complete', (req, res) => {
    try {
        const { id } = req.params;
        
        const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }

        const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const timestamp = getTimestamp();

        db.prepare('UPDATE jobs SET completed_at = ?, updated_at = ? WHERE id = ?').run(dateStr, timestamp, id);
        
        const updatedJob = getJobWithDetails(id);
        return sendSuccess(res, updatedJob);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 8. POST /jobs/:id/uncomplete (Uncomplete a job)
router.post('/:id/uncomplete', (req, res) => {
    try {
        const { id } = req.params;

        const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
        if (!job) {
            return sendError(res, 'Job not found', 404);
        }

        const timestamp = getTimestamp();

        db.prepare('UPDATE jobs SET completed_at = NULL, updated_at = ? WHERE id = ?').run(timestamp, id);
        
        const updatedJob = getJobWithDetails(id);
        return sendSuccess(res, updatedJob);
    } catch (err) {
        return sendError(res, err.message);
    }
});

// 9. DELETE /jobs/images/:id (Delete specific job image by ID)
router.delete('/images/:id', (req, res) => {
    try {
        const { id } = req.params;
        const image = db.prepare('SELECT * FROM job_images WHERE id = ?').get(id);
        
        if (image) {
            deleteImageFile(image.image);
            db.prepare('DELETE FROM job_images WHERE id = ?').run(id);
            return sendSuccess(res, { id: parseInt(id), image: image.image });
        } else {
            return sendError(res, 'Image not found', 404);
        }
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
