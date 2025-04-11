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
import { loadDefaultSettings, RooDefaultSettings, RooDefaultStateSettings } from "./core/config/defaultSettingsLoader" // Updated import

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
	const defaultSettings = await loadDefaultSettings(outputChannel)

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
	// const effectiveSettings = await mergeRooCodeSettings(defaultSettings, userConfig, context.secrets, outputChannel)
	// --- End Merge settings ---

	// TODO: Modify ClineProvider constructor/init to accept and use effectiveSettings
	// For now, effectiveSettings is prepared but not yet passed or used.
	// Pass the fully merged settings to ClineProvider
	// Note: ClineProvider's constructor or an init method might need adjustment
	// to accept this potentially more complex 'effectiveSettings' structure.
	// For now, we assume it can handle the structure derived from merging.
	const provider = new ClineProvider(context, outputChannel, "sidebar", defaultSettings)
	await provider.contextProxy.initialize()
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
// async function mergeRooCodeSettings(
// 	defaultSettings: RooDefaultSettings | null,
// 	userConfig: vscode.WorkspaceConfiguration,
// 	secrets: vscode.SecretStorage,
// 	outputChannel: vscode.OutputChannel,
// ): Promise<RooDefaultSettings> {
// 	const effectiveSettings: RooDefaultSettings = {
// 		state: {
// 			apiProvider: "anthropic", // Default value
// 			currentApiConfigName: "nix", // Default value
// 			mode: "nix", // Default value
// 			apiModelId: "nix"
// 		},
// 		secrets: {}
// 	};

// 	// Helper to check if a user has configured a specific setting
// 	const hasUserConfig = (key: string): boolean => {
// 		const inspection = userConfig.inspect(key)
// 		return inspection?.globalValue !== undefined || inspection?.workspaceValue !== undefined
// 	}

// 	// Helper to get user config value (preference to workspace over global)
// 	const getUserConfigValue = <T>(key: string): T | undefined => {
// 		return userConfig.get<T>(key)
// 	}

// 	// Helper to log applied defaults
// 	const logAppliedDefault = (key: string, value: any) => {
// 		// Avoid logging sensitive values directly
// 		const displayValue =
// 			typeof value === "string" && (key.toLowerCase().includes("apikey") || key.toLowerCase().includes("secret"))
// 				? "********"
// 				: JSON.stringify(value)
// 		logger.info(`Applying default setting from .roodefaults: ${key} = ${displayValue}`)
// 		// Also log to output channel for visibility during activation
// 		outputChannel.appendLine(`Applying default setting from .roodefaults: ${key}`)
// 	}

// 	// --- Merge Settings ---
// 	if (defaultSettings) {
// 		if (defaultSettings.state?.mode) {
// 			effectiveSettings.mode = defaultSettings.state.mode;
// 			logAppliedDefault("globalSettings.mode", defaultSettings.state.mode);
// 		}

// 		if (defaultSettings.state?.currentApiConfigName) {
// 			effectiveSettings.currentApiConfigName = defaultSettings.state.currentApiConfigName;
// 			logAppliedDefault("providerProfiles.currentApiConfigName", defaultSettings.state.currentApiConfigName);
// 		}

// 		if (defaultSettings.state?.apiProvider) {
// 			effectiveSettings.apiProvider = defaultSettings.state.apiProvider as ProviderName;
// 			logAppliedDefault("providerProfiles.apiConfigs.default.apiProvider", defaultSettings.state.apiProvider);
// 		}

// 		if (defaultSettings.state?.apiModelId) {
// 			effectiveSettings.apiModelId = defaultSettings.state.apiModelId;
// 			logAppliedDefault("providerProfiles.apiConfigs.default.apiProvider", defaultSettings.state.apiProvider);
// 		}

// 	// 	// Add listApiConfigMeta from defaultSettings if it exists
// 	// 	if (defaultSettings.globalSettings?.listApiConfigMeta) {
// 	// 		effectiveSettings.listApiConfigMeta = defaultSettings.globalSettings.listApiConfigMeta;
// 	// 		logAppliedDefault("globalSettings.listApiConfigMeta", defaultSettings.globalSettings.listApiConfigMeta);
// 	// 	}
// 	}

// 	// --- Overlay User Config and Secrets (takes precedence) ---
// 	if (hasUserConfig("mode")) {
// 		effectiveSettings.mode = getUserConfigValue<string>("mode") ?? effectiveSettings.mode;
// 	}
// 	if (hasUserConfig("currentApiConfigName")) {
// 		effectiveSettings.currentApiConfigName = getUserConfigValue<string>("currentApiConfigName") ?? effectiveSettings.currentApiConfigName;
// 	}
// 	if (hasUserConfig("apiProvider")) {
// 		effectiveSettings.apiProvider = getUserConfigValue<ProviderName>("apiProvider") ?? effectiveSettings.apiProvider;
// 	}

// 	return effectiveSettings;
// }
