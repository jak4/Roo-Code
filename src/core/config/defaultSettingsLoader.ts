import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
import { logger } from "../../utils/logging"

const ROO_DEFAULTS_FILENAME = ".roodefaults"

/**
 * Represents a single API configuration profile within .roodefaults.
 */
export interface RooDefaultApiConfig {
	apiProvider?: string
	apiModelId?: string
	openRouterApiKey?: string // Sensitive
	openRouterModelId?: string
	geminiApiKey?: string // Sensitive
	requestyApiKey?: string // Sensitive
	requestyModelId?: string
	// Add other provider-specific settings here
}

/**
 * Represents the provider profiles section in .roodefaults.
 */
export interface RooDefaultProviderProfiles {
	currentApiConfigName?: string
	apiConfigs?: {
		[key: string]: RooDefaultApiConfig
	}
}

/**
 * Represents the global settings section in .roodefaults.
 */
export interface RooDefaultGlobalSettings {
	autoApprovalEnabled?: boolean
	allowedCommands?: string[]
	experiments?: { [key: string]: any }
	mode?: string
	customModes?: any[] // Define a proper type if structure is known
	// Add other global settings mirroring the main configuration structure
	modelTemperature?: number // Example from previous version, kept for potential use
}

/**
 * Represents the complete structure of the .roodefaults JSON file.
 */
export interface RooDefaultSettings {
	providerProfiles?: RooDefaultProviderProfiles
	globalSettings?: RooDefaultGlobalSettings
}

/**
 * Loads default settings from the .roodefaults file in the workspace root.
 *
 * @returns A promise that resolves to an object containing the default settings,
 *          or an empty object if the file doesn't exist or contains errors.
 */
export async function loadDefaultSettings(): Promise<RooDefaultSettings | null> {
	const workspaceFolders = vscode.workspace.workspaceFolders
	if (!workspaceFolders || workspaceFolders.length === 0) {
		logger.debug("No workspace folder open, skipping .roodefaults loading.")
		return null // Indicate no defaults loaded
	}

	// Use the first workspace folder as the root. Consider multi-root scenarios if needed.
	const workspaceRoot = workspaceFolders[0].uri.fsPath
	const defaultsFilePath = path.join(workspaceRoot, ROO_DEFAULTS_FILENAME)

	try {
		logger.info(`Attempting to load default settings from: ${defaultsFilePath}`)
		const fileContent = await fs.readFile(defaultsFilePath, "utf-8")

		if (!fileContent.trim()) {
			logger.debug(`'.roodefaults' file exists but is empty. Skipping default settings loading.`)
			return null // Indicate no defaults loaded
		}

		const defaults = JSON.parse(fileContent) as RooDefaultSettings
		// Basic validation for top-level keys
		if (
			typeof defaults !== "object" ||
			defaults === null ||
			(!defaults.providerProfiles && !defaults.globalSettings)
		) {
			logger.warn(
				`'.roodefaults' file does not contain the expected top-level 'providerProfiles' or 'globalSettings' keys. Skipping.`,
			)
			return null
		}

		logger.info(`Successfully parsed default settings from '.roodefaults'.`)

		// Security Warning Check
		checkAndLogSecurityWarnings(defaults)

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
		return null // Indicate no defaults loaded or error occurred
	}
}

/**
 * Checks for sensitive data within the loaded defaults and logs warnings.
 * @param defaults The parsed default settings object.
 */
function checkAndLogSecurityWarnings(defaults: RooDefaultSettings): void {
	const sensitiveKeysFound: string[] = []

	if (defaults.providerProfiles?.apiConfigs) {
		for (const profileName in defaults.providerProfiles.apiConfigs) {
			const config = defaults.providerProfiles.apiConfigs[profileName]
			if (config.openRouterApiKey)
				sensitiveKeysFound.push(`providerProfiles.apiConfigs.${profileName}.openRouterApiKey`)
			if (config.geminiApiKey) sensitiveKeysFound.push(`providerProfiles.apiConfigs.${profileName}.geminiApiKey`)
			if (config.requestyApiKey)
				sensitiveKeysFound.push(`providerProfiles.apiConfigs.${profileName}.requestyApiKey`)
			// Add checks for other potential sensitive keys here
		}
	}

	// Add checks for sensitive keys in globalSettings if any exist in the future

	if (sensitiveKeysFound.length > 0) {
		logger.warn(
			`SECURITY WARNING: Sensitive data found in '.roodefaults' for the following keys: ${sensitiveKeysFound.join(", ")}. Storing secrets in this file is insecure if committed to version control. Ensure '.roodefaults' is added to your .gitignore file.`,
		)
	}
}
