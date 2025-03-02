import Database from 'better-sqlite3';
import path from 'path';

// Resolve the database file path to use the data folder
const dbPath = path.resolve(__dirname, '../data/cricket.db');
const db = new Database(dbPath);

// Define interfaces for rows
export interface MatchRow {
  id: string;
  teamName: string;
  toss: string;
  venue: string;
  matchDate: string;
  isOpen: number; // stored as 0 or 1
  actualRuns: number | null;
  actualWickets: number | null;
}

export interface PredictionRow {
  matchId: string;
  userId: string;
  username: string;
  runs: number;
  wickets: number;
}

// Create tables if they don't exist
db.exec(`
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  teamName TEXT NOT NULL,
  toss TEXT NOT NULL,
  venue TEXT NOT NULL,
  matchDate TEXT NOT NULL,
  isOpen INTEGER NOT NULL,
  actualRuns INTEGER,
  actualWickets INTEGER
);

CREATE TABLE IF NOT EXISTS predictions (
  matchId TEXT,
  userId TEXT,
  username TEXT,
  runs INTEGER,
  wickets INTEGER,
  PRIMARY KEY (matchId, userId),
  FOREIGN KEY (matchId) REFERENCES matches(id)
);
`);

export const insertMatch = (match: {
  id: string;
  teamName: string;
  toss: string;
  venue: string;
  matchDate: string;
  isOpen: boolean;
}): void => {
  const stmt = db.prepare(`
    INSERT INTO matches (id, teamName, toss, venue, matchDate, isOpen)
    VALUES (@id, @teamName, @toss, @venue, @matchDate, @isOpen)
  `);
  stmt.run({ ...match, isOpen: match.isOpen ? 1 : 0 });
};

export const updateMatch = (match: {
  id: string;
  isOpen?: boolean;
  actualRuns?: number;
  actualWickets?: number;
}): void => {
  const stmt = db.prepare(`
    UPDATE matches SET 
      isOpen = COALESCE(@isOpen, isOpen),
      actualRuns = COALESCE(@actualRuns, actualRuns),
      actualWickets = COALESCE(@actualWickets, actualWickets)
    WHERE id = @id
  `);
  stmt.run({
    id: match.id,
    isOpen: match.isOpen !== undefined ? (match.isOpen ? 1 : 0) : undefined,
    actualRuns: match.actualRuns,
    actualWickets: match.actualWickets,
  });
};

export const insertOrUpdatePrediction = (prediction: {
  matchId: string;
  userId: string;
  username: string;
  runs: number;
  wickets: number;
}): void => {
  const stmt = db.prepare(`
    INSERT INTO predictions (matchId, userId, username, runs, wickets)
    VALUES (@matchId, @userId, @username, @runs, @wickets)
    ON CONFLICT(matchId, userId) DO UPDATE SET
      username = excluded.username,
      runs = excluded.runs,
      wickets = excluded.wickets
  `);
  stmt.run(prediction);
};

export const getPredictionsForMatch = (matchId: string): PredictionRow[] => {
  const stmt = db.prepare(`SELECT * FROM predictions WHERE matchId = ?`);
  return stmt.all(matchId) as PredictionRow[];
};

export const getPastMatches = (): MatchRow[] => {
  const stmt = db.prepare(`SELECT * FROM matches WHERE isOpen = 0 ORDER BY matchDate DESC`);
  return stmt.all() as MatchRow[];
};

export const getMatchDetails = (
  matchId: string
): { match: MatchRow; predictions: PredictionRow[] } | null => {
  const matchStmt = db.prepare(`SELECT * FROM matches WHERE id = ?`);
  const match = matchStmt.get(matchId) as MatchRow | undefined;
  if (!match) return null;
  const predictions = getPredictionsForMatch(matchId);
  return { match, predictions };
};
