const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const docxParser = require("docx-parser");
const natural = require("natural");
require("dotenv").config();

const app = express();
const PORT = 5000;

app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

const upload = multer({ dest: "uploads/" });

const tfidf = new natural.TfIdf();

const escapeRegExp = (string) =>
  string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const extractTextFromFile = async (file) => {
  const filePath = file.path;
  try {
    if (file.mimetype === "application/pdf") {
      const dataBuffer = fs.readFileSync(filePath);
      return await pdfParse(dataBuffer).then((data) => data.text);
    } else if (file.mimetype.includes("word")) {
      return await new Promise((resolve, reject) => {
        docxParser.parseDocx(filePath, (err, data) => {
          if (err) reject(err);
          resolve(data);
        });
      });
    } else if (file.mimetype === "text/plain") {
      return fs.readFileSync(filePath, "utf-8");
    }
    throw new Error("Unsupported file type");
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error("Error deleting file:", err.message);
    }
  }
};

const getCosineSimilarity = (vector1, vector2) => {
  const maxLength = Math.max(vector1.length, vector2.length);
  const extendedVector1 = Array.from({ length: maxLength }, (_, i) => vector1[i] || 0);
  const extendedVector2 = Array.from({ length: maxLength }, (_, i) => vector2[i] || 0);

  const dotProduct = extendedVector1.reduce((sum, val, i) => sum + val * extendedVector2[i], 0);
  const magnitude1 = Math.sqrt(extendedVector1.reduce((sum, val) => sum + val ** 2, 0));
  const magnitude2 = Math.sqrt(extendedVector2.reduce((sum, val) => sum + val ** 2, 0));

  return dotProduct / (magnitude1 * magnitude2 || 1);
};

const calculateTfIdfVector = (text) => {
  const vector = Array(tfidf.documents.length).fill(0);
  tfidf.tfidfs(text, (i, measure) => {
    vector[i] = measure;
  });
  return vector;
};

// Original plagiarism checking route
app.post("/check-plagiarism", upload.single("file"), async (req, res) => {
  const { text } = req.body;
  const file = req.file;
  let contentToCheck = text || "";

  try {
    if (file) {
      contentToCheck = await extractTextFromFile(file);
    }

    if (!contentToCheck.trim()) {
      return res.status(400).send({ error: "No valid content to check for plagiarism!" });
    }

    const normalizedText = contentToCheck.replace(/\s+/g, " ").trim();

    const options = {
      method: "GET",
      url: "https://google-search72.p.rapidapi.com/search",
      params: { q: normalizedText, lr: "en-US", num: "10" },
      headers: {
        "x-rapidapi-key": process.env.RAPIDAPI_KEY,
        "x-rapidapi-host": "google-search72.p.rapidapi.com",
      },
    };

    const response = await axios.request(options);
    const results = response.data.items || [];

    tfidf.addDocument(normalizedText);
    results.forEach((result) => {
      tfidf.addDocument(result.title);
      tfidf.addDocument(result.snippet || "");
    });

    const highlightedResults = results.map((result) => {
      const titleVector = calculateTfIdfVector(result.title);
      const snippetVector = calculateTfIdfVector(result.snippet || "");
      const textVector = calculateTfIdfVector(normalizedText);

      const titleSimilarity = getCosineSimilarity(textVector, titleVector) * 100;
      const snippetSimilarity = getCosineSimilarity(textVector, snippetVector) * 100;

      return {
        ...result,
        highlightedTitle: result.title.replace(
          new RegExp(`(${escapeRegExp(normalizedText)})`, "gi"),
          '<span style="background-color: yellow;">$1</span>'
        ),
        highlightedSnippet: result.snippet
          ? result.snippet.replace(
            new RegExp(`(${escapeRegExp(normalizedText)})`, "gi"),
            '<span style="background-color: yellow;">$1</span>'
          )
          : null,
        titleSimilarity,
        snippetSimilarity,
      };
    });

    const highestSnippetSimilarity = Math.max(
      ...highlightedResults.map((res) => res.snippetSimilarity || 0)
    );

    res.send({
      plagiarismPercentage: highestSnippetSimilarity.toFixed(2),
      plagiarizedText: normalizedText,
      results: highlightedResults,
    });
  } catch (error) {
    console.error("Error checking plagiarism:", error.message);
    res.status(500).send({ error: "An error occurred." });
  }
});

// New route for checking plagiarism using Python SVM
app.post("/check-plagiarism-svm", upload.single("file"), async (req, res) => {
  const { text } = req.body;
  const file = req.file;

  let contentToCheck = text || "";

  try {
    if (file) {
      contentToCheck = await extractTextFromFile(file);
    }

    if (!contentToCheck.trim()) {
      return res.status(400).send({ error: "No valid content to check for plagiarism!" });
    }

    // Call the Python API
    const response = await axios.post("http://localhost:5001/check-plagiarism", {
      text: contentToCheck,
    });

    // Send response back to the client
    res.send(response.data);
  } catch (error) {
    console.error("Error checking plagiarism via SVM:", error.message);
    res.status(500).send({ error: "An error occurred." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
