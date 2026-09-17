const express = require('express');
const cors = require('cors');
const path = require('path'); // Added the path module
const { classifySQL } = require('./classifier');

const app = express();
app.use(cors());
app.use(express.json());

// Tell Node to serve your frontend folder as a web page
app.use(express.static(path.join(__dirname, '../frontend')));

app.post('/classify', (req, res) => {
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: "SQL input is required" });
    
    const result = classifySQL(sql);
    res.json(result);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));