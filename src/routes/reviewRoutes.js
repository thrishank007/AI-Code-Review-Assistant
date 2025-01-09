const express = require('express');
const { body, validationResult } = require('express-validator');
const { getReviews, addReview, deleteReview, getReviewById } = require('../controllers/reviewController');
const authenticate = require('../middlewares/auth');

const router = express.Router();

// Middleware for input validation
const validateReview = [
  body('code').isString().notEmpty().withMessage('Code is required'),
  body('modelName').isString().notEmpty().withMessage('Model name is required'),
];

// Get all reviews
router.get('/', authenticate, getReviews);

// Add a new review
router.post('/', authenticate, validateReview, (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}, addReview);

// Delete a review
router.delete('/:reviewId', authenticate, deleteReview);

// Get a Review by Id
router.get('/:reviewId', authenticate, getReviewById);

module.exports = router;