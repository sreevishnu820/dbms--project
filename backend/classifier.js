// classifier.js
function classifySQL(sqlQuery) {
    // Normalize: remove single-line comments, trim whitespace, and grab the first word
    const cleanSQL = sqlQuery.replace(/--.*$/gm, '').trim();
    const firstWord = cleanSQL.split(/\s+/)[0].toUpperCase();

    const rules = {
        'CREATE': { category: 'DDL', command: 'CREATE', purpose: 'Defines database structure', effect: 'Creates a new table, view, or other object in the database.' },
        'ALTER': { category: 'DDL', command: 'ALTER', purpose: 'Modifies existing structure', effect: 'Changes the structure of an existing database object.' },
        'DROP': { category: 'DDL', command: 'DROP', purpose: 'Deletes database structure', effect: 'Removes an object from the database entirely.' },
        'TRUNCATE': { category: 'DDL', command: 'TRUNCATE', purpose: 'Removes all records', effect: 'Empties a table completely but keeps its structure.' },
        'INSERT': { category: 'DML', command: 'INSERT', purpose: 'Adds new data', effect: 'Adds one or more new rows to a table.' },
        'UPDATE': { category: 'DML', command: 'UPDATE', purpose: 'Modifies existing data', effect: 'Changes the values in existing rows.' },
        'DELETE': { category: 'DML', command: 'DELETE', purpose: 'Removes data', effect: 'Deletes one or more rows from a table.' },
        'SELECT': { category: 'DQL', command: 'SELECT', purpose: 'Retrieves data', effect: 'Fetches specific data from the database without modifying it.' },
        'GRANT': { category: 'DCL', command: 'GRANT', purpose: 'Gives user access privileges', effect: 'Provides specific permissions to a user or role.' },
        'REVOKE': { category: 'DCL', command: 'REVOKE', purpose: 'Removes user access privileges', effect: 'Takes back previously granted permissions.' },
        'COMMIT': { category: 'TCL', command: 'COMMIT', purpose: 'Saves transactions', effect: 'Permanently saves all changes made during the current transaction.' },
        'ROLLBACK': { category: 'TCL', command: 'ROLLBACK', purpose: 'Undoes transactions', effect: 'Reverts the database to its state before the transaction started.' }
    };

    if (rules[firstWord]) {
        return { 
            valid: true, 
            input: sqlQuery, 
            ...rules[firstWord], 
            explanation: `The command starts with ${firstWord}, which is a ${rules[firstWord].category} command used to ${rules[firstWord].purpose.toLowerCase()}.` 
        };
    }

    return { 
        valid: false, 
        input: sqlQuery, 
        category: 'Error', 
        command: firstWord, 
        purpose: 'N/A', 
        effect: 'N/A', 
        explanation: `The keyword '${firstWord}' does not match standard DDL, DML, DQL, DCL, or TCL commands.` 
    };
}

module.exports = { classifySQL };