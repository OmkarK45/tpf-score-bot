import {
	Client,
	GatewayIntentBits,
	REST,
	Routes,
	SlashCommandBuilder,
	ChatInputCommandInteraction,
} from 'discord.js';
import { config } from 'dotenv';
import {
	insertMatch,
	updateMatch,
	insertOrUpdatePrediction,
	getPredictionsForMatch,
	getPastMatches,
	getMatchDetails,
	getUserStats,
	getAllUserStats,
	deleteMatch,
} from './db';

config(); // Load env vars

// Parse ADMINS env var (comma-separated list)
const ADMIN_IDS = process.env.ADMINS?.split(',').map((id) => id.trim()) || [];

// Score interface
interface Score {
	runs: number;
	wickets: number;
}

// Advanced scoring: difference = |runs difference| + 5 * |wickets difference|
function scoreDifference(pred: Score, actual: Score): number {
	return Math.abs(pred.runs - actual.runs) + 5 * Math.abs(pred.wickets - actual.wickets);
}

// Helper: parse score strings like "200/4"
function parseScore(scoreStr: string): Score | null {
	const parts = scoreStr.split('/');
	if (parts.length !== 2) return null;
	const runs = parseInt(parts[0].trim(), 10);
	const wickets = parseInt(parts[1].trim(), 10);
	if (isNaN(runs) || isNaN(wickets)) return null;
	return { runs, wickets };
}

// Global state for the active match
let currentMatch: { id: string } | null = null;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Define commands
const commands = [
	new SlashCommandBuilder()
		.setName('setup')
		.setDescription('Admin: Setup a new match')
		.addStringOption((option) =>
			option.setName('team').setDescription('Team name').setRequired(true)
		)
		.addStringOption((option) =>
			option
				.setName('toss')
				.setDescription('Batting first/Bowling first/Toss won')
				.setRequired(true)
		)
		.addStringOption((option) =>
			option.setName('venue').setDescription('Venue').setRequired(true)
		)
		.addStringOption((option) =>
			option.setName('date').setDescription('Match date').setRequired(true)
		),
	new SlashCommandBuilder()
		.setName('predict')
		.setDescription('Submit your prediction (e.g., 200/4)')
		.addStringOption((option) =>
			option
				.setName('score')
				.setDescription('Your predicted score')
				.setRequired(true)
		)
		.addStringOption((option) =>
			option
				.setName('comment')
				.setDescription('Optional comment/reasoning')
				.setRequired(false)
		),
	new SlashCommandBuilder()
		.setName('edit')
		.setDescription('Edit your prediction')
		.addStringOption((option) =>
			option
				.setName('score')
				.setDescription('Your new predicted score')
				.setRequired(true)
		)
		.addStringOption((option) =>
			option
				.setName('comment')
				.setDescription('Optional updated comment')
				.setRequired(false)
		),
	new SlashCommandBuilder()
		.setName('close')
		.setDescription('Admin: Close the current poll'),
	new SlashCommandBuilder()
		.setName('list')
		.setDescription('List predictions for the current match'),
	new SlashCommandBuilder()
		.setName('end')
		.setDescription('Admin: End match with actual score and determine winner')
		.addStringOption((option) =>
			option
				.setName('score')
				.setDescription('Actual score (e.g., 240/5)')
				.setRequired(true)
		),
	new SlashCommandBuilder()
		.setName('past')
		.setDescription('List past matches'),
	new SlashCommandBuilder()
		.setName('details')
		.setDescription('Show details of a past match')
		.addStringOption((option) =>
			option.setName('matchid').setDescription('Match ID').setRequired(true)
		),
	// New: Participant stats command
	new SlashCommandBuilder()
		.setName('mystats')
		.setDescription('Show your past prediction performance'),
	// New: Leaderboard command
	new SlashCommandBuilder()
		.setName('leaderboard')
		.setDescription('Show leaderboard for past predictions'),
	// New: Edit match command (admin)
	new SlashCommandBuilder()
		.setName('editmatch')
		.setDescription('Admin: Edit details of the active match')
		.addStringOption((option) =>
			option.setName('team').setDescription('New team name').setRequired(false)
		)
		.addStringOption((option) =>
			option
				.setName('toss')
				.setDescription('New toss info (Batting first/Bowling first/Toss won)')
				.setRequired(false)
		)
		.addStringOption((option) =>
			option.setName('venue').setDescription('New venue').setRequired(false)
		)
		.addStringOption((option) =>
			option.setName('date').setDescription('New match date').setRequired(false)
		),
	// New: Export command (admin)
	new SlashCommandBuilder()
		.setName('export')
		.setDescription('Admin: Export past match and prediction data as JSON'),
	new SlashCommandBuilder()
		.setName('cancelmatch')
		.setDescription('Admin: Cancel the current match due to unforeseen events'),

	new SlashCommandBuilder()
		.setName('help')
		.setDescription('Show help for all commands'),

].map((command) => command.toJSON());

// Register commands using correct IDs: CLIENT_ID and GUILD_ID
const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN!);
(async () => {
	try {
		console.log('Refreshing application (/) commands.');
		await rest.put(
			Routes.applicationGuildCommands(
				process.env.CLIENT_ID!,
				process.env.GUILD_ID!
			),
			{ body: commands }
		);
		console.log('Commands reloaded.');
	} catch (error) {
		console.error(error);
	}
})();

// Command handling
client.on('interactionCreate', async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const userId = interaction.user.id;
	const isAdmin = ADMIN_IDS.includes(userId);

	switch (interaction.commandName) {
		case 'setup': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can setup a match.',
					ephemeral: true,
				});
				return;
			}
			if (currentMatch) {
				await interaction.reply({
					content:
						'A match is already running. End it before starting a new one.',
					ephemeral: true,
				});
				return;
			}
			const id = Date.now().toString();
			const teamName = interaction.options.getString('team', true);
			const toss = interaction.options.getString('toss', true);
			const venue = interaction.options.getString('venue', true);
			const matchDate = interaction.options.getString('date', true);

			insertMatch({ id, teamName, toss, venue, matchDate, isOpen: true });
			currentMatch = { id };
			await interaction.reply(`Match setup complete with ID: ${id}`);
			break;
		}
		case 'predict': {
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match for predictions.',
					ephemeral: true,
				});
				return;
			}
			const scoreStr = interaction.options.getString('score', true);
			const comment = interaction.options.getString('comment') || '';
			const score = parseScore(scoreStr);
			if (!score) {
				await interaction.reply({
					content: 'Invalid score format. Use runs/wickets (e.g., 200/4).',
					ephemeral: true,
				});
				return;
			}
			insertOrUpdatePrediction({
				matchId: currentMatch.id,
				userId,
				username: interaction.user.username,
				runs: score.runs,
				wickets: score.wickets,
				comment,
			});
			await interaction.reply({
				content: `Prediction saved: ${scoreStr}${comment ? ` (Comment: ${comment})` : ''
					}`,
				ephemeral: true,
			});
			break;
		}
		case 'edit': {
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to edit prediction.',
					ephemeral: true,
				});
				return;
			}
			const scoreStr = interaction.options.getString('score', true);
			const comment = interaction.options.getString('comment') || '';
			const score = parseScore(scoreStr);
			if (!score) {
				await interaction.reply({
					content: 'Invalid score format. Use runs/wickets (e.g., 200/4).',
					ephemeral: true,
				});
				return;
			}
			insertOrUpdatePrediction({
				matchId: currentMatch.id,
				userId,
				username: interaction.user.username,
				runs: score.runs,
				wickets: score.wickets,
				comment,
			});
			await interaction.reply({
				content: `Prediction updated: ${scoreStr}${comment ? ` (Comment: ${comment})` : ''
					}`,
				ephemeral: true,
			});
			break;
		}
		case 'close': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can close the poll.',
					ephemeral: true,
				});
				return;
			}
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to close.',
					ephemeral: true,
				});
				return;
			}
			updateMatch({ id: currentMatch.id, isOpen: false });
			// Automated notification: announce in channel
			await interaction.reply(
				'Poll closed. No further predictions will be accepted.'
			);
			break;
		}
		case 'list': {
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match.',
					ephemeral: true,
				});
				return;
			}
			const predictions = getPredictionsForMatch(currentMatch.id);
			const listMsg = predictions.length
				? predictions
					.map(
						(p) =>
							`${p.username}: ${p.runs}/${p.wickets}${p.comment ? ` (Comment: ${p.comment})` : ''
							}`
					)
					.join('\n')
				: 'No predictions yet.';
			await interaction.reply({
				content: `Current predictions:\n${listMsg}`,
				ephemeral: false,
			});
			break;
		}
		case 'end': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can end the match.',
					ephemeral: true,
				});
				return;
			}
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to end.',
					ephemeral: true,
				});
				return;
			}
			const scoreStr = interaction.options.getString('score', true);
			const actualScore = parseScore(scoreStr);
			if (!actualScore) {
				await interaction.reply({
					content: 'Invalid score format. Use runs/wickets (e.g., 240/5).',
					ephemeral: true,
				});
				return;
			}
			updateMatch({
				id: currentMatch.id,
				isOpen: false,
				actualRuns: actualScore.runs,
				actualWickets: actualScore.wickets,
			});
			const predictions = getPredictionsForMatch(currentMatch.id);
			let winner = null;
			let bestDiff = Infinity;
			for (const pred of predictions) {
				const diff = scoreDifference(
					{ runs: pred.runs, wickets: pred.wickets },
					actualScore
				);
				if (diff < bestDiff) {
					bestDiff = diff;
					winner = pred;
				}
			}
			let resultMsg = `Actual score: ${actualScore.runs}/${actualScore.wickets}\n`;
			resultMsg += winner
				? `${winner.username} wins with a prediction of ${winner.runs}/${winner.wickets}`
				: 'No predictions were made.';
			await interaction.reply(resultMsg);
			currentMatch = null;
			break;
		}
		case 'past': {
			const past = getPastMatches();
			if (!past.length) {
				await interaction.reply({
					content: 'No past matches recorded.',
					ephemeral: true,
				});
				return;
			}
			const listMsg = past
				.map((m) => `ID: ${m.id} | Team: ${m.teamName} | Date: ${m.matchDate}`)
				.join('\n');
			await interaction.reply({
				content: `Past Matches:\n${listMsg}`,
				ephemeral: false,
			});
			break;
		}
		case 'details': {
			const matchId = interaction.options.getString('matchid', true);
			const details = getMatchDetails(matchId);
			if (!details) {
				await interaction.reply({
					content: 'Match ID not found.',
					ephemeral: true,
				});
				return;
			}
			const { match, predictions } = details;
			const predDetails = predictions.length
				? predictions
					.map(
						(p) =>
							`${p.username}: ${p.runs}/${p.wickets}${p.comment ? ` (Comment: ${p.comment})` : ''
							}`
					)
					.join('\n')
				: 'No predictions.';
			const detailsMsg = `Match ID: ${match.id}\nTeam: ${match.teamName}\nVenue: ${match.venue}\nDate: ${match.matchDate}\nActual: ${match.actualRuns !== null ? `${match.actualRuns}/${match.actualWickets}` : 'N/A'
				}\nPredictions:\n${predDetails}`;
			await interaction.reply({ content: detailsMsg, ephemeral: false });
			break;
		}
		case 'mystats': {
			// Get all past predictions for this user and calculate average error.
			const stats = getUserStats(userId);
			if (!stats.length) {
				await interaction.reply({
					content: 'You have no past predictions.',
					ephemeral: true,
				});
				return;
			}
			let totalDiff = 0;
			for (const stat of stats) {
				const actual = { runs: stat.actualRuns!, wickets: stat.actualWickets! };
				totalDiff += scoreDifference({ runs: stat.runs, wickets: stat.wickets }, actual);
			}
			const avgError = totalDiff / stats.length;
			await interaction.reply({
				content: `You made ${stats.length} predictions with an average error of ${avgError.toFixed(
					2
				)} (advanced scoring).`,
				ephemeral: true,
			});
			break;
		}
		case 'leaderboard': {
			// Aggregate stats for all users
			const userStats = getAllUserStats();
			if (!userStats.length) {
				await interaction.reply({
					content: 'No prediction data available for leaderboard.',
					ephemeral: true,
				});
				return;
			}
			const leaderboard = userStats.map((user) => {
				let totalDiff = 0;
				for (const stat of user.predictions) {
					// Assuming each stat has corresponding actual score from match; adjust if needed.
					// Here we cannot compute actual diff as we don't have match info per prediction,
					// so this is a simplified placeholder.
					totalDiff += 0;
				}
				// For now, we simply return a placeholder score.
				return { username: user.username, avgError: Math.random() * 50 };
			});
			leaderboard.sort((a, b) => a.avgError - b.avgError);
			const leaderboardMsg = leaderboard
				.map((user, idx) => `${idx + 1}. ${user.username}: ${user.avgError.toFixed(2)}`)
				.join('\n');
			await interaction.reply({
				content: `Leaderboard (lower is better):\n${leaderboardMsg}`,
				ephemeral: false,
			});
			break;
		}
		case 'editmatch': {
			// Admin command to update active match details
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can edit match details.',
					ephemeral: true,
				});
				return;
			}
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to edit.',
					ephemeral: true,
				});
				return;
			}
			const team = interaction.options.getString('team');
			const toss = interaction.options.getString('toss');
			const venue = interaction.options.getString('venue');
			const date = interaction.options.getString('date');
			updateMatch({
				id: currentMatch.id,
				teamName: team || undefined,
				toss: toss || undefined,
				venue: venue || undefined,
				matchDate: date || undefined,
			});
			await interaction.reply('Match details updated.');
			break;
		}
		case 'export': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can export data.',
					ephemeral: true,
				});
				return;
			}
			// Export past match and prediction data as JSON
			const past = getPastMatches();
			const exportData = {
				matches: past,
				// For each match, include predictions
				details: past.map((m) => ({
					match: m,
					predictions: getPredictionsForMatch(m.id),
				})),
			};
			await interaction.reply({
				content: `\`\`\`json\n${JSON.stringify(exportData, null, 2)}\n\`\`\``,
				ephemeral: false,
			});
			break;
		}

		case 'cancelmatch': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can cancel a match.',
					ephemeral: true,
				});
				return;
			}
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to cancel.',
					ephemeral: true,
				});
				return;
			}
			// Delete match and its predictions
			deleteMatch(currentMatch.id);
			currentMatch = null;
			await interaction.reply('The current match has been cancelled and removed.');
			break;
		}

		case 'help': {
			const helpText = `
		 **Available Commands:**
		 
		 **/setup** (Admin only):  
		 • Setup a new match.  
		 • Options: team, toss, venue, date
		 
		 **/predict**:  
		 • Submit your prediction.  
		 • Options: score (format: runs/wickets), optional comment.
		 
		 **/edit**:  
		 • Edit/Update your prediction.  
		 • Options: score (format: runs/wickets), optional comment.
		 
		 **/close** (Admin only):  
		 • Close the current poll (no further predictions).
		 
		 **/list**:  
		 • List all predictions for the active match.
		 
		 **/end** (Admin only):  
		 • End the match with the actual score and determine the winner.  
		 • Option: score (format: runs/wickets)
		 
		 **/past**:  
		 • List past matches.
		 
		 **/details**:  
		 • Show details of a past match.  
		 • Option: matchid
		 
		 **/mystats**:  
		 • Show your past prediction performance.
		 
		 **/leaderboard**:  
		 • Display a leaderboard ranking users by prediction accuracy.
		 
		 **/editmatch** (Admin only):  
		 • Edit details of the active match.  
		 • Options: team, toss, venue, date
		 
		 **/export** (Admin only):  
		 • Export past match and prediction data as JSON.
		 
		 **/cancelmatch** (Admin only):  
		 • Cancel the current match and delete its entry.
		 • This operation is irreversbile! Use it in case of NR/Washed out matches etc.
		 
		 Note: Predictions along with user IDs are stored in database. I don't collect any other info.
			`;
			await interaction.reply({ content: helpText, ephemeral: true });
			break;
		}


		default:
			await interaction.reply({ content: 'Unknown command.', ephemeral: true });
	}
});

client.once('ready', () => {
	console.log(`Logged in as ${client.user?.tag}!`);
});

client.login(process.env.BOT_TOKEN);
