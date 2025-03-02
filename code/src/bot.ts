import {
	Client,
	GatewayIntentBits,
	REST,
	Routes,
	SlashCommandBuilder,
	ChatInputCommandInteraction,
} from 'discord.js'
import { config } from 'dotenv'
import {
	insertMatch,
	updateMatch,
	insertOrUpdatePrediction,
	getPredictionsForMatch,
	getPastMatches,
	getMatchDetails,
} from './db'

config() // Load env vars

// Parse ADMINS env var (comma-separated list)
const ADMIN_IDS = process.env.ADMINS?.split(',').map((id) => id.trim()) || []

// Score interface
interface Score {
	runs: number
	wickets: number
}

// Helper: parse score strings like "200/4"
function parseScore(scoreStr: string): Score | null {
	const parts = scoreStr.split('/')
	if (parts.length !== 2) return null
	const runs = parseInt(parts[0].trim(), 10)
	const wickets = parseInt(parts[1].trim(), 10)
	if (isNaN(runs) || isNaN(wickets)) return null
	return { runs, wickets }
}

// Helper: compute closeness (using runs difference)
function scoreDifference(pred: Score, actual: Score): number {
	return Math.abs(pred.runs - actual.runs)
}

// Global state for the active match
let currentMatch: { id: string } | null = null

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

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
		),
	new SlashCommandBuilder()
		.setName('edit')
		.setDescription('Edit your prediction')
		.addStringOption((option) =>
			option
				.setName('score')
				.setDescription('Your new predicted score')
				.setRequired(true)
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
	new SlashCommandBuilder().setName('past').setDescription('List past matches'),
	new SlashCommandBuilder()
		.setName('details')
		.setDescription('Show details of a past match')
		.addStringOption((option) =>
			option.setName('matchid').setDescription('Match ID').setRequired(true)
		),
].map((command) => command.toJSON())

// Register commands
const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN!)
;(async () => {
	try {
		console.log('Refreshing application (/) commands.')
		await rest.put(
			Routes.applicationGuildCommands(
			  process.env.CLIENT_ID!,
			  process.env.GUILD_ID!
			),
			{ body: commands }
		 );
		 
		console.log('Commands reloaded.')
	} catch (error) {
		console.error(error)
	}
})()

// Command handling
client.on('interactionCreate', async (interaction) => {
	if (!interaction.isChatInputCommand()) return
	const userId = interaction.user.id
	const isAdmin = ADMIN_IDS.includes(userId)

	switch (interaction.commandName) {
		case 'setup': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can setup a match.',
					ephemeral: true,
				})
				return
			}
			if (currentMatch) {
				await interaction.reply({
					content:
						'A match is already running. End it before starting a new one.',
					ephemeral: true,
				})
				return
			}
			const id = Date.now().toString()
			const teamName = interaction.options.getString('team', true)
			const toss = interaction.options.getString('toss', true)
			const venue = interaction.options.getString('venue', true)
			const matchDate = interaction.options.getString('date', true)

			insertMatch({ id, teamName, toss, venue, matchDate, isOpen: true })
			currentMatch = { id }
			await interaction.reply(`Match setup complete with ID: ${id}`)
			break
		}
		case 'predict': {
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match for predictions.',
					ephemeral: true,
				})
				return
			}
			const scoreStr = interaction.options.getString('score', true)
			const score = parseScore(scoreStr)
			if (!score) {
				await interaction.reply({
					content: 'Invalid score format. Use runs/wickets (e.g., 200/4).',
					ephemeral: true,
				})
				return
			}
			insertOrUpdatePrediction({
				matchId: currentMatch.id,
				userId,
				username: interaction.user.username,
				runs: score.runs,
				wickets: score.wickets,
			})
			await interaction.reply({
				content: `Prediction saved: ${scoreStr}`,
				ephemeral: true,
			})
			break
		}
		case 'edit': {
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to edit prediction.',
					ephemeral: true,
				})
				return
			}
			const scoreStr = interaction.options.getString('score', true)
			const score = parseScore(scoreStr)
			if (!score) {
				await interaction.reply({
					content: 'Invalid score format. Use runs/wickets (e.g., 200/4).',
					ephemeral: true,
				})
				return
			}
			insertOrUpdatePrediction({
				matchId: currentMatch.id,
				userId,
				username: interaction.user.username,
				runs: score.runs,
				wickets: score.wickets,
			})
			await interaction.reply({
				content: `Prediction updated: ${scoreStr}`,
				ephemeral: true,
			})
			break
		}
		case 'close': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can close the poll.',
					ephemeral: true,
				})
				return
			}
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to close.',
					ephemeral: true,
				})
				return
			}
			updateMatch({ id: currentMatch.id, isOpen: false })
			await interaction.reply(
				'Poll closed. No further predictions will be accepted.'
			)
			break
		}
		case 'list': {
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match.',
					ephemeral: true,
				})
				return
			}
			const predictions = getPredictionsForMatch(currentMatch.id)
			const listMsg = predictions.length
				? predictions
						.map((p: any) => `${p.username}: ${p.runs}/${p.wickets}`)
						.join('\n')
				: 'No predictions yet.'
			await interaction.reply({
				content: `Current predictions:\n${listMsg}`,
				ephemeral: false,
			})
			break
		}
		case 'end': {
			if (!isAdmin) {
				await interaction.reply({
					content: 'Only admins can end the match.',
					ephemeral: true,
				})
				return
			}
			if (!currentMatch) {
				await interaction.reply({
					content: 'No active match to end.',
					ephemeral: true,
				})
				return
			}
			const scoreStr = interaction.options.getString('score', true)
			const actualScore = parseScore(scoreStr)
			if (!actualScore) {
				await interaction.reply({
					content: 'Invalid score format. Use runs/wickets (e.g., 240/5).',
					ephemeral: true,
				})
				return
			}
			updateMatch({
				id: currentMatch.id,
				isOpen: false,
				actualRuns: actualScore.runs,
				actualWickets: actualScore.wickets,
			})
			const predictions = getPredictionsForMatch(currentMatch.id)
			let winner = null
			let bestDiff = Infinity
			for (const pred of predictions) {
				const diff = scoreDifference(
					{ runs: pred.runs, wickets: pred.wickets },
					actualScore
				)
				if (diff < bestDiff) {
					bestDiff = diff
					winner = pred
				}
			}
			let resultMsg = `Actual score: ${actualScore.runs}/${actualScore.wickets}\n`
			resultMsg += winner
				? `${winner.username} wins with a prediction of ${winner.runs}/${winner.wickets}`
				: 'No predictions were made.'
			await interaction.reply(resultMsg)
			currentMatch = null
			break
		}
		case 'past': {
			const past = getPastMatches()
			if (!past.length) {
				await interaction.reply({
					content: 'No past matches recorded.',
					ephemeral: true,
				})
				return
			}
			const listMsg = past
				.map(
					(m: any) => `ID: ${m.id} | Team: ${m.teamName} | Date: ${m.matchDate}`
				)
				.join('\n')
			await interaction.reply({
				content: `Past Matches:\n${listMsg}`,
				ephemeral: false,
			})
			break
		}
		case 'details': {
			const matchId = interaction.options.getString('matchid', true)
			const details = getMatchDetails(matchId)
			if (!details) {
				await interaction.reply({
					content: 'Match ID not found.',
					ephemeral: true,
				})
				return
			}
			const { match, predictions } = details
			const predDetails = predictions.length
				? predictions
						.map((p: any) => `${p.username}: ${p.runs}/${p.wickets}`)
						.join('\n')
				: 'No predictions.'
			const detailsMsg = `Match ID: ${match.id}\nTeam: ${
				match.teamName
			}\nVenue: ${match.venue}\nDate: ${match.matchDate}\nActual: ${
				match.actualRuns !== null
					? `${match.actualRuns}/${match.actualWickets}`
					: 'N/A'
			}\nPredictions:\n${predDetails}`
			await interaction.reply({ content: detailsMsg, ephemeral: false })
			break
		}
		default:
			await interaction.reply({ content: 'Unknown command.', ephemeral: true })
	}
})

client.once('ready', () => {
	console.log(`Logged in as ${client.user?.tag}!`)
})

client.login(process.env.BOT_TOKEN)
