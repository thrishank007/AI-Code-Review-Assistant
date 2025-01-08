const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const analyzeCode = async (code, modelName) => {
  if (!code || !modelName) {
    throw new Error("Code and Model name are required");
  }

  try {
    const analysis = await getAIHandler(modelName)(code);
    return analysis;
  } catch (error) {
    console.error(`Error analyzing code with ${modelName}:`, error.message);
    throw new Error(`Analysis failed for model ${modelName}`);
  }
};

const getAIHandler = (modelName) => {
  const models = {
    openai: callOpenAI,
    gemini: callGeminiAI,
    claude: callClaudeAI,
    qwen: callQwenAI,
  };
  const handler = models[modelName.toLowerCase()];
  if (!handler) {
    throw new Error(`Unsupported Model: ${modelName}`);
  }
  return handler;
};

// Common API Request Wrapper
const apiRequest = async (url, data, headers) => {
  try {
    const response = await axios.post(url, data, { headers, timeout: 10000 });
    return response.data;
  } catch (error) {
    console.error("API Request Error:", error.message);
    throw error;
  }
};

const callOpenAI = async (code) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const url = "https://api.openai.com/v1/completions";
  const data = {
    model: "gpt-4",
    prompt: `Review this code and give a score out of 10:\n\n${code}`,
    max_tokens: 1000,
  };
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

  const response = await apiRequest(url, data, headers);
  return response.choices[0]?.text || "No analysis generated.";
};

const callGeminiAI = async (code) => {
  if (!process.env.GEMINIAI_API_KEY) {
    throw new Error("GEMINIAI_API_KEY is not set");
  }
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINIAI_API_KEY);
    const model = genAI.getGenerativeModel(
      { model: "gemini-1.5-flash" },
      { apiVersion: "v1" }
    );

    const prompt = `Review this code and give a score out of 10:\n\n${code}`;

    const result = await model.generateContent(prompt);

    console.log(result.response.text());
    return result.response.text() || "No analsyis generated.";
  } catch (error) {
    console.error("Gemini AI Error:", error.message);
  }
};

const callClaudeAI = async (code) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const url = " https://api.anthropic.com/v1/messages";
  const data = {
    model: "claude-3-5-sonnet-20241022",
    messages: [
      {
        role: "user",
        content: `Review this code and give a score out of 10:\n\n${code}`,
      },
    ],
    max_tokens: 1024,
  };
  const headers = {
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  const response = await apiRequest(url, data, headers);
  return response.content[0]?.text || "No analysis generated.";
};

const callQwenAI = async (code) => {
  if (!process.env.OLLAMA_URI) {
    throw new Error("OLLAMA_URI is not set");
  }
  const url = `${process.env.OLLAMA_URI}/api/generate`;
  const data = {
    model: "qwen2.5-coder:3b",
    prompt: `Review this code and give a score out of 10\n\n${code}`,
    stream: false,
  };
  const headers = {
    "content-type": "application/json",
  };
  const res = await apiRequest(url, data, headers);
  return res.response.text || "No analysis generated.";
};

module.exports = analyzeCode;
