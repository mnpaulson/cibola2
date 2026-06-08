/**
 * Standard response helpers for consistent API JSON payloads.
 */

/**
 * Send a standardized success JSON response.
 * @param {object} res Express response object
 * @param {any} data The payload data to send
 * @param {number} statusCode HTTP status code (default 200)
 */
function sendSuccess(res, data, statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        data
    });
}

/**
 * Send a standardized paginated JSON response.
 * @param {object} res Express response object
 * @param {Array} data The items on the current page
 * @param {object} paginationInfo Pagination metadata
 * @param {number} paginationInfo.currentPage Current page number
 * @param {number} paginationInfo.lastPage Last page number
 * @param {number} paginationInfo.perPage Items per page limit
 * @param {number} paginationInfo.total Total record count
 * @param {number} [paginationInfo.from] Optional starting record offset index
 * @param {number} [paginationInfo.to] Optional ending record offset index
 * @param {number} statusCode HTTP status code (default 200)
 */
function sendPaginated(res, data, paginationInfo, statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        data,
        pagination: {
            current_page: paginationInfo.currentPage,
            last_page: paginationInfo.lastPage,
            per_page: paginationInfo.perPage,
            total: paginationInfo.total,
            from: paginationInfo.from !== undefined ? paginationInfo.from : (paginationInfo.currentPage - 1) * paginationInfo.perPage + 1,
            to: paginationInfo.to !== undefined ? paginationInfo.to : (paginationInfo.currentPage - 1) * paginationInfo.perPage + data.length
        }
    });
}

/**
 * Send a standardized error JSON response.
 * @param {object} res Express response object
 * @param {string} message Error message
 * @param {number} statusCode HTTP status code (default 500)
 * @param {any} [details] Additional error details
 */
function sendError(res, message, statusCode = 500, details = null) {
    return res.status(statusCode).json({
        success: false,
        error: {
            message,
            ...(details && { details })
        }
    });
}

module.exports = {
    sendSuccess,
    sendPaginated,
    sendError
};
