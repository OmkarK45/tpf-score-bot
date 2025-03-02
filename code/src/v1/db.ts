import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(__dirname, '../../data/cricket.db');
const db = new Database(dbPath);

// Create tables if they don't exist, including a comment column for predictions.
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
  comment TEXT,
  PRIMARY KEY (matchId, userId),
  FOREIGN KEY (matchId) REFERENCES matches(id)
);
`);

export interface MatchRow {
  id: string;
  teamName: string;
  toss: string;
  venue: string;
  matchDate: string;
  // 0 or 1 
  isOpen: number;
  actualRuns: number | null;
  actualWickets: number | null;
}

export interface PredictionRow {
  matchId: string;
  userId: string;
  username: string;
  runs: number;
  wickets: number;
  comment: string | null;
}

// When joining with match data, include actual scores:
export type PredictionWithMatch = PredictionRow & {
  actualRuns: number;
  actualWickets: number;
};

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
  teamName?: string;
  toss?: string;
  venue?: string;
  matchDate?: string;
}): void => {
  const stmt = db.prepare(`
    UPDATE matches SET 
      isOpen = COALESCE(@isOpen, isOpen),
      actualRuns = COALESCE(@actualRuns, actualRuns),
      actualWickets = COALESCE(@actualWickets, actualWickets),
      teamName = COALESCE(@teamName, teamName),
      toss = COALESCE(@toss, toss),
      venue = COALESCE(@venue, venue),
      matchDate = COALESCE(@matchDate, matchDate)
    WHERE id = @id
  `);
  stmt.run({
    id: match.id,
    isOpen: match.isOpen !== undefined ? (match.isOpen ? 1 : 0) : undefined,
    actualRuns: match.actualRuns,
    actualWickets: match.actualWickets,
    teamName: match.teamName,
    toss: match.toss,
    venue: match.venue,
    matchDate: match.matchDate,
  });
};

export const insertOrUpdatePrediction = (prediction: {
  matchId: string;
  userId: string;
  username: string;
  runs: number;
  wickets: number;
  comment?: string;
}): void => {
  const stmt = db.prepare(`
    INSERT INTO predictions (matchId, userId, username, runs, wickets, comment)
    VALUES (@matchId, @userId, @username, @runs, @wickets, @comment)
    ON CONFLICT(matchId, userId) DO UPDATE SET
      username = excluded.username,
      runs = excluded.runs,
      wickets = excluded.wickets,
      comment = excluded.comment
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

// Get all predictions across past matches for a given user with actual match scores
export const getUserStats = (userId: string): PredictionWithMatch[] => {
  const stmt = db.prepare(`
    SELECT p.*, m.actualRuns, m.actualWickets 
    FROM predictions p
    JOIN matches m ON p.matchId = m.id
    WHERE p.userId = ? AND m.isOpen = 0 AND m.actualRuns IS NOT NULL AND m.actualWickets IS NOT NULL
  `);
  return stmt.all(userId) as PredictionWithMatch[];
};

// Get all predictions from past matches grouped by user with match data
export const getAllUserStats = (): {
  userId: string;
  username: string;
  predictions: PredictionWithMatch[];
}[] => {
  const stmt = db.prepare(`
    SELECT p.userId, p.username, p.runs, p.wickets, p.comment, m.actualRuns, m.actualWickets 
    FROM predictions p
    JOIN matches m ON p.matchId = m.id
    WHERE m.isOpen = 0 AND m.actualRuns IS NOT NULL AND m.actualWickets IS NOT NULL
  `);
  const rows = stmt.all() as Array<PredictionWithMatch>;

  // Group by userId
  const grouped: { [userId: string]: { username: string; predictions: PredictionWithMatch[] } } = {};
  for (const row of rows) {
    if (!grouped[row.userId]) {
      grouped[row.userId] = { username: row.username, predictions: [] };
    }
    grouped[row.userId].predictions.push(row);
  }
  return Object.entries(grouped).map(([userId, { username, predictions }]) => ({
    userId,
    username,
    predictions,
  }));
};

export const deleteMatch = (matchId: string): void => {
  const deletePredStmt = db.prepare(`DELETE FROM predictions WHERE matchId = ?`);
  deletePredStmt.run(matchId);
  const deleteMatchStmt = db.prepare(`DELETE FROM matches WHERE id = ?`);
  deleteMatchStmt.run(matchId);
};
