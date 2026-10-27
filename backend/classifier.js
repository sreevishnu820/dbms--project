// classifier.js

function validateSQLSyntax(query) {
    const sql = query.trim().replace(/;+$/, '').trim();
    if (!sql) return { valid: false, error: 'Empty query statement.' };

    // 1. Bracket and quote balancing
    let inStr = false;
    let parens = 0;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'") {
            if (!inStr) inStr = true;
            else if (sql[i + 1] === "'") i++; // escaped quote ''
            else inStr = false;
        } else if (!inStr) {
            if (ch === '(') parens++;
            else if (ch === ')') parens--;
            if (parens < 0) return { valid: false, error: 'Unbalanced closing parenthesis.' };
        }
    }
    if (inStr) return { valid: false, error: 'Unclosed string literal.' };
    if (parens !== 0) return { valid: false, error: 'Unbalanced open parenthesis.' };

    const firstWordMatch = sql.match(/^\s*([a-zA-Z]+)/);
    if (!firstWordMatch) return { valid: false, error: 'Unrecognized statement start.' };
    const firstWord = firstWordMatch[1].toUpperCase();

    // Helper to split by top-level delimiter (ignoring commas inside parentheses and quotes)
    function splitTopLevel(s, delim) {
        const res = []; let cur = ''; let depth = 0; let str = false;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === "'") {
                if (!str) str = true;
                else if (s[i + 1] === "'") { cur += "''"; i++; continue; }
                else str = false;
            } else if (!str) {
                if (c === '(') depth++;
                else if (c === ')') depth--;
                else if (c === delim && depth === 0) {
                    res.push(cur.trim());
                    cur = '';
                    continue;
                }
            }
            cur += c;
        }
        res.push(cur.trim());
        return res;
    }

    // --- SELECT Validation ---
    if (firstWord === 'SELECT') {
        let fromIdx = -1;
        let depth = 0;
        let str = false;
        for (let i = 6; i < sql.length - 4; i++) {
            const c = sql[i];
            if (c === "'") {
                if (!str) str = true;
                else if (sql[i + 1] === "'") { i++; continue; }
                else str = false;
            } else if (!str) {
                if (c === '(') depth++;
                else if (c === ')') depth--;
                else if (depth === 0) {
                    if (/\bFROM\b/i.test(sql.substring(i, i + 5)) && (i === 0 || /\s/.test(sql[i - 1])) && /\s/.test(sql[i + 4] || '')) {
                        fromIdx = i;
                        break;
                    }
                }
            }
        }

        if (fromIdx === -1) {
            return { valid: false, error: 'Invalid SELECT: Missing FROM clause.' };
        }

        const selectPart = sql.substring(0, fromIdx).replace(/^\s*SELECT(?:\s+DISTINCT)?\s+/i, '').trim();
        const afterFrom = sql.substring(fromIdx + 4).trim();

        if (!selectPart) return { valid: false, error: 'No columns specified in SELECT.' };
        if (!afterFrom) return { valid: false, error: 'Missing table name after FROM.' };

        const colList = splitTopLevel(selectPart, ',');
        if (!colList.length) return { valid: false, error: 'No columns specified.' };

        for (const rawCol of colList) {
            const col = rawCol.trim();
            if (!col) return { valid: false, error: 'Extraneous comma or empty column identifier.' };
            if (col === '*' || /^[a-zA-Z_]\w*\.\*$/.test(col)) continue;
            if (/^[+\-*\/%&|^=!<>,]+$/.test(col)) {
                return { valid: false, error: `Invalid column syntax: '${col}' is an operator, not a column expression.` };
            }
            if (/^[+\-*\/%&|^=!<>]/.test(col) && !/^[+\-]\d/.test(col)) {
                return { valid: false, error: `Malformed column expression starting with operator: '${col}'` };
            }
            if (/[+\-*\/%&|^=!<>,]$/.test(col)) {
                return { valid: false, error: `Incomplete column expression ending with operator: '${col}'` };
            }
            if (/[~`$#@\\]/.test(col)) {
                return { valid: false, error: `Illegal character in column '${col}'.` };
            }
        }

        const clauseRegex = /\b(INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|JOIN|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT)\b/gi;
        const clauseMatches = [];
        let match;
        depth = 0; str = false;
        while ((match = clauseRegex.exec(afterFrom)) !== null) {
            const idx = match.index;
            let d = 0, s = false;
            for (let i = 0; i < idx; i++) {
                const ch = afterFrom[i];
                if (ch === "'") {
                    if (!s) s = true;
                    else if (afterFrom[i + 1] === "'") { i++; continue; }
                    else s = false;
                } else if (!s) {
                    if (ch === '(') d++;
                    else if (ch === ')') d--;
                }
            }
            if (!s && d === 0) {
                clauseMatches.push({ kw: match[1].toUpperCase().replace(/\s+/g, ' '), index: idx, len: match[0].length });
            }
        }

        let tableNamePart = '';
        if (clauseMatches.length === 0) {
            tableNamePart = afterFrom.trim();
        } else {
            tableNamePart = afterFrom.substring(0, clauseMatches[0].index).trim();
            for (let k = 0; k < clauseMatches.length; k++) {
                const cur = clauseMatches[k];
                const nextIdx = (k + 1 < clauseMatches.length) ? clauseMatches[k + 1].index : afterFrom.length;
                const clauseBody = afterFrom.substring(cur.index + cur.len, nextIdx).trim();
                if (!clauseBody) {
                    return { valid: false, error: `Clause ${cur.kw} is missing its body or predicate condition.` };
                }
                if (cur.kw.includes('JOIN')) {
                    if (!/\bON\b/i.test(clauseBody)) {
                        return { valid: false, error: `JOIN clause '${clauseBody}' missing ON condition.` };
                    }
                    const onParts = clauseBody.split(/\bON\b/i);
                    if (!onParts[1] || !onParts[1].trim()) {
                        return { valid: false, error: 'JOIN ON missing condition expression.' };
                    }
                }
                if (cur.kw === 'LIMIT') {
                    if (!/^\d+(\s*(?:,\s*\d+|\s+OFFSET\s+\d+))?$/i.test(clauseBody)) {
                        return { valid: false, error: `Invalid LIMIT clause: '${clauseBody}'` };
                    }
                }
            }
        }

        if (!tableNamePart) {
            return { valid: false, error: 'Missing table name in FROM clause.' };
        }
        const tables = splitTopLevel(tableNamePart, ',');
        for (const t of tables) {
            const tr = t.trim();
            if (!tr || !/^[a-zA-Z_]\w*(\s+(AS\s+)?[a-zA-Z_]\w*)?$/i.test(tr)) {
                return { valid: false, error: `Invalid table name or alias '${tr}'` };
            }
        }

        return { valid: true, category: 'DQL', command: 'SELECT' };
    }

    // --- INSERT Validation ---
    if (firstWord === 'INSERT') {
        const m = sql.match(/^\s*INSERT\s+INTO\s+([a-zA-Z_]\w*)(\s*\(([\w\s,]+)\))?\s+VALUES\s*(\([\s\S]+\))\s*$/i);
        if (!m) {
            return { valid: false, error: 'Invalid INSERT syntax. Expected: INSERT INTO table_name [(col1, ...)] VALUES (val1, ...);' };
        }
        return { valid: true, category: 'DML', command: 'INSERT' };
    }

    // --- UPDATE Validation ---
    if (firstWord === 'UPDATE') {
        const m = sql.match(/^\s*UPDATE\s+([a-zA-Z_]\w*)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
        if (!m) {
            return { valid: false, error: 'Invalid UPDATE syntax. Expected: UPDATE table_name SET col = val [WHERE condition];' };
        }
        const setList = splitTopLevel(m[2], ',');
        if (!setList.length) return { valid: false, error: 'UPDATE SET requires column assignments.' };
        for (const item of setList) {
            const it = item.trim();
            if (!it || !/^[a-zA-Z_]\w*\s*=\s*[\s\S]+$/.test(it)) {
                return { valid: false, error: `Invalid assignment in UPDATE SET: '${it}'` };
            }
            const val = it.split('=')[1].trim();
            if (!val) return { valid: false, error: `Missing value in assignment: '${it}'` };
        }
        if (sql.includes('WHERE') && (!m[3] || !m[3].trim())) {
            return { valid: false, error: 'WHERE clause in UPDATE cannot be empty.' };
        }
        return { valid: true, category: 'DML', command: 'UPDATE' };
    }

    // --- DELETE Validation ---
    if (firstWord === 'DELETE') {
        const m = sql.match(/^\s*DELETE\s+FROM\s+([a-zA-Z_]\w*)(?:\s+WHERE\s+([\s\S]+))?$/i);
        if (!m) {
            return { valid: false, error: 'Invalid DELETE syntax. Expected: DELETE FROM table_name [WHERE condition];' };
        }
        if (/\bWHERE\b/i.test(sql) && (!m[2] || !m[2].trim())) {
            return { valid: false, error: 'WHERE clause in DELETE cannot be empty.' };
        }
        return { valid: true, category: 'DML', command: 'DELETE' };
    }

    // --- MERGE Validation ---
    if (firstWord === 'MERGE') {
        if (!/^\s*MERGE\s+INTO\s+[a-zA-Z_]\w*\s+USING\s+[\s\S]+?\s+ON\s+[\s\S]+?(WHEN\s+MATCHED\s+THEN[\s\S]+|WHEN\s+NOT\s+MATCHED\s+THEN[\s\S]+)\s*$/i.test(sql)) {
            return { valid: false, error: 'Invalid MERGE syntax. Expected: MERGE INTO target USING source ON condition WHEN MATCHED...;' };
        }
        return { valid: true, category: 'DML', command: 'MERGE' };
    }

    // --- CREATE Validation ---
    if (firstWord === 'CREATE') {
        if (/^\s*CREATE\s+TABLE\s+[a-zA-Z_]\w*\s*\([\s\S]+\)\s*$/i.test(sql)) {
            return { valid: true, category: 'DDL', command: 'CREATE' };
        }
        if (/^\s*CREATE\s+(DATABASE|SCHEMA)\s+[a-zA-Z_]\w*\s*$/i.test(sql)) {
            return { valid: true, category: 'DDL', command: 'CREATE' };
        }
        if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+[a-zA-Z_]\w*\s+ON\s+[a-zA-Z_]\w*\s*\([\s\S]+\)\s*$/i.test(sql)) {
            return { valid: true, category: 'DDL', command: 'CREATE' };
        }
        if (/^\s*CREATE\s+VIEW\s+[a-zA-Z_]\w*\s+AS\s+SELECT\s+[\s\S]+$/i.test(sql)) {
            return { valid: true, category: 'DDL', command: 'CREATE' };
        }
        return { valid: false, error: 'Invalid CREATE statement. Expected: CREATE TABLE table_name (...), CREATE DATABASE db_name, CREATE INDEX ... ON table(col), or CREATE VIEW name AS SELECT ...' };
    }

    // --- ALTER Validation ---
    if (firstWord === 'ALTER') {
        if (/^\s*ALTER\s+TABLE\s+[a-zA-Z_]\w*\s+(ADD(\s+COLUMN)?|DROP(\s+COLUMN)?|MODIFY(\s+COLUMN)?|RENAME(\s+COLUMN|\s+TO)?)\s+[a-zA-Z_]\w*(\s+[\s\S]+)?$/i.test(sql)) {
            if (/^\s*ALTER\s+TABLE\s+[a-zA-Z_]\w*\s+(ADD|DROP|MODIFY|RENAME)\s*$/i.test(sql)) {
                return { valid: false, error: 'Incomplete ALTER TABLE specification.' };
            }
            return { valid: true, category: 'DDL', command: 'ALTER' };
        }
        return { valid: false, error: 'Invalid ALTER statement. Expected: ALTER TABLE table_name ADD/DROP/MODIFY/RENAME column_name datatype;' };
    }

    // --- DROP Validation ---
    if (firstWord === 'DROP') {
        if (/^\s*DROP\s+(TABLE|DATABASE|INDEX|VIEW)(\s+IF\s+EXISTS)?\s+[a-zA-Z_]\w*(\s+(CASCADE|RESTRICT))?\s*$/i.test(sql)) {
            return { valid: true, category: 'DDL', command: 'DROP' };
        }
        return { valid: false, error: 'Invalid DROP statement. Expected: DROP TABLE/DATABASE/VIEW/INDEX name;' };
    }

    // --- TRUNCATE Validation ---
    if (firstWord === 'TRUNCATE') {
        if (/^\s*TRUNCATE\s+(TABLE\s+)?[a-zA-Z_]\w*\s*$/i.test(sql)) {
            return { valid: true, category: 'DDL', command: 'TRUNCATE' };
        }
        return { valid: false, error: 'Invalid TRUNCATE statement. Expected: TRUNCATE TABLE table_name;' };
    }

    // --- RENAME Validation ---
    if (firstWord === 'RENAME') {
        if (/^\s*RENAME\s+TABLE\s+[a-zA-Z_]\w*\s+TO\s+[a-zA-Z_]\w*\s*$/i.test(sql)) {
            return { valid: true, category: 'DDL', command: 'RENAME' };
        }
        return { valid: false, error: 'Invalid RENAME statement. Expected: RENAME TABLE old_name TO new_name;' };
    }

    // --- WITH Validation ---
    if (firstWord === 'WITH') {
        if (/^\s*WITH\s+[a-zA-Z_]\w*\s+AS\s*\([\s\S]+\)\s*SELECT\s+[\s\S]+$/i.test(sql)) {
            return { valid: true, category: 'DQL', command: 'WITH' };
        }
        return { valid: false, error: 'Invalid WITH (CTE) syntax. Expected: WITH cte_name AS (SELECT ...) SELECT ...' };
    }

    // --- GRANT Validation ---
    if (firstWord === 'GRANT') {
        if (/^\s*GRANT\s+[\w\s,]+\s+ON\s+[\w.]+\s+TO\s+[\w@'%]+(\s+WITH\s+GRANT\s+OPTION)?\s*$/i.test(sql)) {
            return { valid: true, category: 'DCL', command: 'GRANT' };
        }
        return { valid: false, error: 'Invalid GRANT statement. Expected: GRANT privilege ON object TO user;' };
    }

    // --- REVOKE Validation ---
    if (firstWord === 'REVOKE') {
        if (/^\s*REVOKE\s+[\w\s,]+\s+ON\s+[\w.]+\s+FROM\s+[\w@'%]+\s*$/i.test(sql)) {
            return { valid: true, category: 'DCL', command: 'REVOKE' };
        }
        return { valid: false, error: 'Invalid REVOKE statement. Expected: REVOKE privilege ON object FROM user;' };
    }

    // --- COMMIT Validation ---
    if (firstWord === 'COMMIT') {
        if (/^\s*COMMIT(\s+WORK|\s+TRANSACTION)?\s*$/i.test(sql)) {
            return { valid: true, category: 'TCL', command: 'COMMIT' };
        }
        return { valid: false, error: 'Invalid COMMIT statement. Expected: COMMIT;' };
    }

    // --- ROLLBACK Validation ---
    if (firstWord === 'ROLLBACK') {
        if (/^\s*ROLLBACK(\s+WORK|\s+TRANSACTION)?(\s+TO\s+(SAVEPOINT\s+)?[a-zA-Z_]\w*)?\s*$/i.test(sql)) {
            return { valid: true, category: 'TCL', command: 'ROLLBACK' };
        }
        return { valid: false, error: 'Invalid ROLLBACK statement. Expected: ROLLBACK [TO SAVEPOINT savepoint_name];' };
    }

    // --- SAVEPOINT Validation ---
    if (firstWord === 'SAVEPOINT') {
        if (/^\s*SAVEPOINT\s+[a-zA-Z_]\w*\s*$/i.test(sql)) {
            return { valid: true, category: 'TCL', command: 'SAVEPOINT' };
        }
        return { valid: false, error: 'Invalid SAVEPOINT statement. Expected: SAVEPOINT savepoint_name;' };
    }

    return { valid: false, error: `Unrecognized SQL command keyword: '${firstWord}'.` };
}

function classifySQL(sqlQuery) {
    const cleanSQL = sqlQuery.replace(/--.*$/gm, '').trim();
    const firstWord = (cleanSQL.match(/^\s*([a-zA-Z]+)/) || [])[1] || '';
    const upperFirst = firstWord.toUpperCase();

    const rules = {
        'CREATE': { category: 'DDL', command: 'CREATE', purpose: 'Defines database structure', effect: 'Creates a new table, view, or other object in the database.' },
        'ALTER': { category: 'DDL', command: 'ALTER', purpose: 'Modifies existing structure', effect: 'Changes the structure of an existing database object.' },
        'DROP': { category: 'DDL', command: 'DROP', purpose: 'Deletes database structure', effect: 'Removes an object from the database entirely.' },
        'TRUNCATE': { category: 'DDL', command: 'TRUNCATE', purpose: 'Removes all records', effect: 'Empties a table completely but keeps its structure.' },
        'RENAME': { category: 'DDL', command: 'RENAME', purpose: 'Renames database objects', effect: 'Changes the name of an existing table or object.' },
        'INSERT': { category: 'DML', command: 'INSERT', purpose: 'Adds new data', effect: 'Adds one or more new rows to a table.' },
        'UPDATE': { category: 'DML', command: 'UPDATE', purpose: 'Modifies existing data', effect: 'Changes the values in existing rows.' },
        'DELETE': { category: 'DML', command: 'DELETE', purpose: 'Removes data', effect: 'Deletes one or more rows from a table.' },
        'MERGE': { category: 'DML', command: 'MERGE', purpose: 'Upserts / synchronizes rows', effect: 'Conditionally inserts, updates, or deletes target records.' },
        'SELECT': { category: 'DQL', command: 'SELECT', purpose: 'Retrieves data', effect: 'Fetches specific data from the database without modifying it.' },
        'WITH': { category: 'DQL', command: 'WITH', purpose: 'Common Table Expression (CTE)', effect: 'Defines a temporary result set for querying.' },
        'GRANT': { category: 'DCL', command: 'GRANT', purpose: 'Gives user access privileges', effect: 'Provides specific permissions to a user or role.' },
        'REVOKE': { category: 'DCL', command: 'REVOKE', purpose: 'Removes user access privileges', effect: 'Takes back previously granted permissions.' },
        'COMMIT': { category: 'TCL', command: 'COMMIT', purpose: 'Saves transactions', effect: 'Permanently saves all changes made during the current transaction.' },
        'ROLLBACK': { category: 'TCL', command: 'ROLLBACK', purpose: 'Undoes transactions', effect: 'Reverts the database to its state before the transaction started.' },
        'SAVEPOINT': { category: 'TCL', command: 'SAVEPOINT', purpose: 'Marks transaction checkpoint', effect: 'Stores a point within a transaction to roll back to.' }
    };

    const validation = validateSQLSyntax(cleanSQL);

    if (validation.valid) {
        const info = rules[upperFirst] || { category: validation.category, command: validation.command, purpose: 'Executes SQL operation', effect: 'Modifies or inspects database state.' };
        return {
            valid: true,
            input: sqlQuery,
            category: info.category,
            command: info.command,
            purpose: info.purpose,
            effect: info.effect,
            explanation: `Valid SQL syntax. Statement classified as ${info.category} (${info.purpose}).`
        };
    }

    return {
        valid: false,
        input: sqlQuery,
        category: 'Error',
        command: upperFirst || 'UNKNOWN',
        purpose: 'N/A',
        effect: 'None. The statement contains syntax errors and will not execute.',
        explanation: validation.error || `Syntax error in '${sqlQuery}'.`
    };
}

module.exports = { classifySQL, validateSQLSyntax };