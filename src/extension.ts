import * as vscode from "vscode"
import * as dotenvx from "@dotenvx/dotenvx"
import * as path from "path"

// Load environment variables from .env file
try {
	// Specify path to .env file in the project root directory
	const envPath = path.join(__dirname, "..", ".env")
	dotenvx.config({ path: envPath })
} catch (e) {
	// Silently handle environment loading errors
	console.warn("Failed to load environment variables:", e)
}

import "./utils/path" // Necessary to have access to String.prototype.toPosix.

import { initializeI18n } from "./i18n"
import { ClineProvider } from "./core/webview/ClineProvider"
import { CodeActionProvider } from "./core/CodeActionProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { logger } from "./utils/logging"
import { ProviderName, providerNames } from "./schemas" // Import ProviderName and providerNames
import {
	EffectiveRooCodeSettings,
	EffectiveProviderProfiles,
	EffectiveApiConfig,
	EffectiveGlobalSettings,
} from "./schemas"
import { telemetryService } from "./services/telemetry/TelemetryService"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { API } from "./exports/api"
import { migrateSettings } from "./utils/migrateSettings"
import {
	loadDefaultSettings,
	RooDefaultSettings,
	RooDefaultGlobalSettings,
	RooDefaultProviderProfiles,
	RooDefaultApiConfig,
} from "./core/config/defaultSettingsLoader" // Updated import

import { handleUri, registerCommands, registerCodeActions, registerTerminalActions } from "./activate"
import { formatLanguage } from "./shared/language"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let extensionContext: vscode.ExtensionContext

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context
	outputChannel = vscode.window.createOutputChannel("Roo-Code")
	context.subscriptions.push(outputChannel)
	outputChannel.appendLine("Roo-Code extension activated")

	// Load default settings from .roodefaults
	const defaultSettings = await loadDefaultSettings()

	// Migrate old settings to new
	await migrateSettings(context, outputChannel)

	// Initialize telemetry service after environment variables are loaded.
	telemetryService.initialize()

	// Initialize i18n for internationalization support
	initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// --- Merge settings from .roodefaults and user configuration ---
	const userConfig = vscode.workspace.getConfiguration("roo-code")
	const effectiveSettings = await mergeRooCodeSettings(defaultSettings, userConfig, context.secrets, outputChannel)
	// --- End Merge settings ---

	// TODO: Modify ClineProvider constructor/init to accept and use effectiveSettings
	// For now, effectiveSettings is prepared but not yet passed or used.
	// Pass the fully merged settings to ClineProvider
	// Note: ClineProvider's constructor or an init method might need adjustment
	// to accept this potentially more complex 'effectiveSettings' structure.
	// For now, we assume it can handle the structure derived from merging.
	const provider = new ClineProvider(context, outputChannel, "sidebar", effectiveSettings)
	telemetryService.setProvider(provider)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ClineProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	registerCommands({ context, outputChannel, provider })

	/**
	 * We use the text document content provider API to show the left side for diff
	 * view by creating a virtual document for the original content. This makes it
	 * readonly so users know to edit the right side if they want to keep their changes.
	 *
	 * This API allows you to create readonly documents in VSCode from arbitrary
	 * sources, and works by claiming an uri-scheme for which your provider then
	 * returns text contents. The scheme must be provided when registering a
	 * provider and cannot change afterwards.
	 *
	 * Note how the provider doesn't create uris for virtual documents - its role
	 * is to provide contents given such an uri. In return, content providers are
	 * wired into the open document logic so that providers are always considered.
	 *
	 * https://code.visualstudio.com/api/extension-guides/virtual-documents
	 */
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
	)

	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register code actions provider.
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider({ pattern: "**/*" }, new CodeActionProvider(), {
			providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds,
		}),
	)

	registerCodeActions(context)
	registerTerminalActions(context)

	// Allows other extensions to activate once Roo is ready.
	vscode.commands.executeCommand("roo-cline.activationCompleted")

	// Implements the `RooCodeAPI` interface.
	const socketPath = process.env.ROO_CODE_IPC_SOCKET_PATH
	const enableLogging = typeof socketPath === "string"
	return new API(outputChannel, provider, socketPath, enableLogging)
}

// This method is called when your extension is deactivated
export async function deactivate() {
	outputChannel.appendLine("Roo-Code extension deactivated")
	// Clean up MCP server manager
	await McpServerManager.cleanup(extensionContext)
	telemetryService.shutdown()

	// Clean up terminal handlers
	TerminalRegistry.cleanup()
}

// --- Helper Function for Merging Settings ---

/**
 * Merges settings from .roodefaults with user's VS Code configuration and secrets.
 * User settings and secrets take precedence over .roodefaults.
 *
 * @param defaultSettings Settings loaded from .roodefaults (can be null).
 * @param userConfig The VS Code workspace configuration for 'roo-code'.
 * @param secrets The VS Code SecretStorage instance.
 * @param outputChannel Channel for logging messages.
 * @returns A promise resolving to the merged effective settings.
 */
async function mergeRooCodeSettings(
	defaultSettings: RooDefaultSettings | null,
	userConfig: vscode.WorkspaceConfiguration,
	secrets: vscode.SecretStorage,
	outputChannel: vscode.OutputChannel,
): Promise<EffectiveRooCodeSettings> {
	const effectiveSettings: EffectiveRooCodeSettings = {
		providerProfiles: { apiConfigs: {} }, // Initialize nested structures
		globalSettings: {},
	}

	// Helper to check if a user has configured a specific setting
	const hasUserConfig = (key: string): boolean => {
		const inspection = userConfig.inspect(key)
		return inspection?.globalValue !== undefined || inspection?.workspaceValue !== undefined
	}

	// Helper to get user config value (preference to workspace over global)
	const getUserConfigValue = <T>(key: string): T | undefined => {
		return userConfig.get<T>(key)
	}

	// Helper to log applied defaults
	const logAppliedDefault = (key: string, value: any) => {
		// Avoid logging sensitive values directly
		const displayValue =
			typeof value === "string" && (key.toLowerCase().includes("apikey") || key.toLowerCase().includes("secret"))
				? "********"
				: JSON.stringify(value)
		logger.info(`Applying default setting from .roodefaults: ${key} = ${displayValue}`)
		// Also log to output channel for visibility during activation
		outputChannel.appendLine(`Applying default setting from .roodefaults: ${key}`)
	}

	// --- Merge Global Settings ---
	const effectiveGlobal: EffectiveGlobalSettings = {} // Start with empty effective global settings
	if (defaultSettings?.globalSettings) {
		const defaultGlobal = defaultSettings.globalSettings
		for (const key in defaultGlobal) {
			if (Object.prototype.hasOwnProperty.call(defaultGlobal, key)) {
				const typedKey = key as keyof RooDefaultGlobalSettings
				const fullKey = `globalSettings.${typedKey}`
				const defaultValue = defaultGlobal[typedKey]

				if (hasUserConfig(fullKey)) {
					// User config takes precedence
					const userValue = getUserConfigValue<any>(fullKey) // Get value as any
					if (userValue !== undefined) {
						;(effectiveGlobal as any)[typedKey] = userValue // Assign using 'any' assertion
					} else if (defaultValue !== undefined) {
						// Fallback to default if user config somehow returns undefined for an existing key
						;(effectiveGlobal as any)[typedKey] = defaultValue // Assign using 'any' assertion
					}
				} else if (defaultValue !== undefined) {
					// Apply default if no user config
					;(effectiveGlobal as any)[typedKey] = defaultValue // Assign using 'any' assertion
					logAppliedDefault(fullKey, defaultValue)
				}
			}
		}
	}
	// Ensure essential global settings from user config are included even if not in defaults
	const userGlobalConfig = userConfig.get<object>("globalSettings")
	if (userGlobalConfig) {
		for (const key in userGlobalConfig) {
			if (Object.prototype.hasOwnProperty.call(userGlobalConfig, key)) {
				const typedKey = key as keyof EffectiveGlobalSettings
				if (effectiveGlobal[typedKey] === undefined) {
					// Only add if not already set by defaults/specific user check
					effectiveGlobal[typedKey] = (userGlobalConfig as any)[key]
				}
			}
		}
	}

	effectiveSettings.globalSettings = effectiveGlobal // Assign the merged global settings object
	// Ensure essential global settings have final fallbacks if still missing
	if (effectiveSettings.globalSettings?.mode === undefined) {
		effectiveSettings.globalSettings!.mode = "code" // Default mode if nothing else specified
	}
	// Add other essential fallbacks if needed

	// --- Merge Provider Profiles ---
	if (defaultSettings?.providerProfiles) {
		// currentApiConfigName
		const currentApiConfigNameKey = "providerProfiles.currentApiConfigName"
		if (hasUserConfig(currentApiConfigNameKey)) {
			effectiveSettings.providerProfiles!.currentApiConfigName = getUserConfigValue(currentApiConfigNameKey)
		} else if (defaultSettings.providerProfiles.currentApiConfigName !== undefined) {
			effectiveSettings.providerProfiles!.currentApiConfigName =
				defaultSettings.providerProfiles.currentApiConfigName
			logAppliedDefault(currentApiConfigNameKey, defaultSettings.providerProfiles.currentApiConfigName)
		}

		// apiConfigs - Merge default profiles first, then overlay user profiles
		const effectiveApiConfigs: { [key: string]: EffectiveApiConfig } = {}

		// 1. Apply defaults
		if (defaultSettings.providerProfiles.apiConfigs) {
			for (const profileName in defaultSettings.providerProfiles.apiConfigs) {
				if (Object.prototype.hasOwnProperty.call(defaultSettings.providerProfiles.apiConfigs, profileName)) {
					const defaultProfile = defaultSettings.providerProfiles.apiConfigs[profileName]
					const effectiveProfile: EffectiveApiConfig = {} // Start fresh for each profile

					for (const key in defaultProfile) {
						if (Object.prototype.hasOwnProperty.call(defaultProfile, key)) {
							const typedKey = key as keyof RooDefaultApiConfig
							const fullKey = `providerProfiles.apiConfigs.${profileName}.${typedKey}`
							const defaultValue = defaultProfile[typedKey]

							if (defaultValue !== undefined) {
								if (typedKey === "apiProvider") {
									// Ensure the default value is a valid ProviderName before assigning
									if (providerNames.includes(defaultValue as ProviderName)) {
										effectiveProfile.apiProvider = defaultValue as ProviderName
									} else {
										logger.warn(
											`Invalid default apiProvider '${defaultValue}' found in .roodefaults for profile '${profileName}'. Skipping.`,
										)
									}
								} else {
									// Use 'as any' for other dynamic assignments
									;(effectiveProfile as any)[typedKey] = defaultValue
								}
								// Log potential application (only if value was actually assigned)
								if ((effectiveProfile as any)[typedKey] !== undefined) {
									logAppliedDefault(fullKey, defaultValue)
								}
							}
						}
					}
					effectiveApiConfigs[profileName] = effectiveProfile // Add profile with defaults applied
				}
			}
		}

		// 2. Overlay User Config and Secrets (takes precedence)
		const userProfiles = userConfig.get<{ [key: string]: any }>("providerProfiles.apiConfigs")
		if (userProfiles) {
			for (const profileName in userProfiles) {
				if (Object.prototype.hasOwnProperty.call(userProfiles, profileName)) {
					const userProfile = userProfiles[profileName]
					if (!effectiveApiConfigs[profileName]) {
						effectiveApiConfigs[profileName] = {} // Initialize if profile only exists in user config
					}
					const effectiveProfile = effectiveApiConfigs[profileName]

					for (const key in userProfile) {
						if (Object.prototype.hasOwnProperty.call(userProfile, key)) {
							const typedKey = key as keyof EffectiveApiConfig
							const fullKey = `providerProfiles.apiConfigs.${profileName}.${typedKey}`
							const secretKey = `roo-code.${fullKey}`
							const userValue = userProfile[key]

							// Check secrets first for API keys
							if (typedKey.toLowerCase().includes("apikey")) {
								const secretValue = await secrets.get(secretKey)
								if (secretValue !== undefined) {
									;(effectiveProfile as any)[typedKey] = secretValue // Use 'as any' for assignment
									logger.debug(`Using secret value for ${fullKey}`)
									continue // Move to next key for this profile
								}
							}

							// Apply user config value (overrides default)
							if (userValue !== undefined) {
								// Use 'as any' for assignment
								;(effectiveProfile as any)[typedKey] = userValue
								logger.debug(`Using user config value for ${fullKey}`)
							}
						}
					}
				}
			}
		}

		// 3. Final check for secrets for profiles defined *only* in defaults (user config didn't override)
		if (defaultSettings?.providerProfiles?.apiConfigs) {
			for (const profileName in defaultSettings.providerProfiles.apiConfigs) {
				if (effectiveApiConfigs[profileName] && (!userProfiles || !userProfiles[profileName])) {
					// Profile exists from defaults, but not touched by user config overlay loop
					const effectiveProfile = effectiveApiConfigs[profileName]
					for (const key in effectiveProfile) {
						if (Object.prototype.hasOwnProperty.call(effectiveProfile, key)) {
							const typedKey = key as keyof EffectiveApiConfig
							if (typedKey.toLowerCase().includes("apikey")) {
								const fullKey = `providerProfiles.apiConfigs.${profileName}.${typedKey}`
								const secretKey = `roo-code.${fullKey}`
								const secretValue = await secrets.get(secretKey)
								if (secretValue !== undefined) {
									;(effectiveProfile as any)[typedKey] = secretValue // Use 'as any' for assignment
									logger.debug(`Using secret value for ${fullKey} (default profile)`)
								}
							}
						}
					}
				}
			}
		}

		effectiveSettings.providerProfiles!.apiConfigs = effectiveApiConfigs
	}
	// Ensure a default profile exists if none configured by user or defaults
	if (Object.keys(effectiveSettings.providerProfiles?.apiConfigs ?? {}).length === 0) {
		effectiveSettings.providerProfiles!.apiConfigs!["default"] = { apiProvider: "gemini" } // Basic fallback
		effectiveSettings.providerProfiles!.currentApiConfigName = "default"
		logger.info("No provider profiles configured, creating a basic 'default' profile.")
	}
	if (
		!effectiveSettings.providerProfiles?.currentApiConfigName &&
		Object.keys(effectiveSettings.providerProfiles?.apiConfigs ?? {}).length > 0
	) {
		// If configs exist but no current name, pick the first one
		effectiveSettings.providerProfiles!.currentApiConfigName = Object.keys(
			effectiveSettings.providerProfiles!.apiConfigs!,
		)[0]
		logger.info(
			`No current API config name set, defaulting to '${effectiveSettings.providerProfiles!.currentApiConfigName}'.`,
		)
	}

	logger.info("Finished merging Roo-Code settings.")
	// console.log("Effective Settings:", JSON.stringify(effectiveSettings, null, 2)); // DEBUG: Log final settings
	return effectiveSettings
}
