const mongoose = require("mongoose");

const codeReviewSchema = new mongoose.Schema(
  {
    reviewId: {
      type: String,
      required: true,
      unique: true,
    },
    code: {
      type: String,
      required: true,
    },
    modelName: {
      type: String,
      required: true,
    },
    analysis: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { collection: "reviews" }
);

const CodeReview = mongoose.model("CodeReview", codeReviewSchema);
module.exports = CodeReview;