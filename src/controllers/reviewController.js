const CodeReview = require("../models/CodeReview");
const ReviewLog = require("../models/ReviewLog");
const analyzeCode = require("../services/aiService");
const { v4: uuidv4 } = require("uuid");

// Get all reviews
const getReviews = async (req, res) => {
  try {
    const reviews = await CodeReview.find();
    res.status(200).json(reviews);
  } catch (err) {
    console.error("Error fetching reviews:", err);
    res.status(500).json({ error: "Error fetching reviews" });
  }
};

const getReviewById = async (req, res) => {
  const { reviewId } = req.params;
  try {
    const review = await CodeReview.findOne({reviewId});
    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }
    res.status(200).json(review);
  } catch (error) {
    console.error("Error fetching review:", error);
    res.status(500).json({ error: "Error fetching review" });
  }
};
// Add a new review
const addReview = async (req, res) => {
  const { code, modelName } = req.body;
  const reviewId = uuidv4();

  try {
    // Analyze code using AI
    const analysis = await analyzeCode(code, modelName);

    // Store the review
    const newReview = await CodeReview.create({
      reviewId,
      code,
      modelName,
      analysis,
    });

    // Log for the review analysis
    await ReviewLog.create({
      reviewId,
      log: `Review analysis started for model: ${modelName}`,
    });

    res.status(201).json(newReview);
  } catch (err) {
    console.error("Error adding review:", err);
    res.status(500).json({ error: "Error adding review" });
  }
};

// Delete a review
const deleteReview = async (req, res) => {
  const { reviewId } = req.params;

  try {
    const review = await CodeReview.findOne({ reviewId });
    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }

    await review.deleteOne();

    // Log entry for review deletion
    await ReviewLog.create({
      reviewId,
      log: `Review with ID ${reviewId} has been deleted.`,
    });

    res.status(200).json({ message: "Review deleted successfully" });
  } catch (err) {
    console.error("Error deleting review:", err);
    res.status(500).json({ error: "Error deleting review" });
  }
};

module.exports = {
  getReviews,
  addReview,
  deleteReview,
  getReviewById,
};
