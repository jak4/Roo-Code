import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
import { logger } from "../../utils/logging"

const ROO_DEFAULTS_FILENAME = ".roodefaults"

/**
 * Represents the global settings section in .roodefaults.
 */
export interface RooDefaultStateSettings {
	mode?: string
	apiProvider?: string
	apiModelId?: string
	currentApiConfigName?: string
	allowedCommands?: string[]
}

/**
 * Represents the complete structure of the .roodefaults JSON file.
 */
export interface RooDefaultSettings {
	state?: RooDefaultStateSettings
	secrets?: { [key: string]: string }
}

/**
 * Loads default settings from the .roodefaults file in the workspace root.
 *
 * @returns A promise that resolves to an object containing the default settings,
 *          or an empty object if the file doesn't exist or contains errors.
 */
export async function loadDefaultSettings(
	outputChannel: vscode.OutputChannel,
): Promise<RooDefaultSettings | undefined> {
	const workspaceFolders = vscode.workspace.workspaceFolders
	if (!workspaceFolders || workspaceFolders.length === 0) {
		logger.debug("No workspace folder open, skipping .roodefaults loading.")
		outputChannel.appendLine(`workspaceFolders: ${JSON.stringify(workspaceFolders)}`)
		return undefined // Indicate no defaults loaded
	}
	// Use the first workspace folder as the root. Consider multi-root scenarios if needed.
	const workspaceRoot = workspaceFolders?.[0].uri.fsPath
	outputChannel.appendLine(`workspaceRoot: ${workspaceRoot}`)
	const defaultsFilePath = workspaceRoot ? path.join(workspaceRoot, ROO_DEFAULTS_FILENAME) : ""

	try {
		logger.info(`Attempting to load default settings from: ${defaultsFilePath}`)
		outputChannel.appendLine(`defaultsFilePath: ${defaultsFilePath}`)
		const fileContent = await fs.readFile(defaultsFilePath, "utf-8")
		outputChannel.appendLine(`fileContent: ${fileContent}`)

		if (!fileContent.trim()) {
			logger.debug(`'.roodefaults' file exists but is empty. Skipping default settings loading.`)
			return undefined // Indicate no defaults loaded
		}

		let defaults: RooDefaultSettings | null = null
		try {
			defaults = JSON.parse(fileContent) as RooDefaultSettings
			outputChannel.appendLine(`Successfully parsed .roodefaults`)
		} catch (e) {
			outputChannel.appendLine(`Error parsing .roodefaults: ${e}`)
			return undefined
		}
		// Basic validation for top-level keys
		if (typeof defaults !== "object" || defaults === null || (!defaults.state && !defaults.secrets)) {
			logger.warn(
				`'.roodefaults' file does not contain the expected top-level 'state' and 'secrets' keys. Skipping.`,
			)
			return undefined
		}

		logger.info(`Successfully parsed default settings from '.roodefaults'.`)

		return defaults
	} catch (error: any) {
		if (error.code === "ENOENT") {
			// File not found is expected, no warning needed unless debugging
			logger.debug(`'.roodefaults' file not found at ${defaultsFilePath}.`)
		} else if (error instanceof SyntaxError) {
			logger.warn(`Failed to parse '.roodefaults' as JSON: ${error.message}. Please ensure it's valid JSON.`)
		} else {
			logger.warn(`Error reading '.roodefaults' file: ${error.message}`)
		}
		return undefined // Indicate no defaults loaded or error occurred
	}
}
