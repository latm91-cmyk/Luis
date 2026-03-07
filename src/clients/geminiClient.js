const response = await axios.post(
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent",
  {
    contents: [
      {
        role: "user",
        parts: [{ text: systemPrompt }]
      },
      {
        role: "user",
        parts: [{ text: userMessage }]
      }
    ]
  },
  {
    params: { key: process.env.GEMINI_API_KEY }
  }
);
