import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { areJidsSameUser, jidNormalizedUser } from 'baileys';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeMaybeJid(jid) {
    if (!jid) return null;
    try {
        return jidNormalizedUser(jid);
    } catch {
        return jid;
    }
}

function uniqueJids(jids) {
    return Array.from(new Set(jids.filter(Boolean).map(normalizeMaybeJid)));
}

function participantJids(participant) {
    return uniqueJids([
        participant?.id,
        participant?.lid,
        participant?.phoneNumber
    ]);
}

function botJids(sock) {
    const me = sock.authState?.creds?.me || sock.user || {};
    return uniqueJids([
        me.id,
        me.lid,
        me.phoneNumber,
        sock.user?.id,
        sock.user?.lid,
        sock.user?.phoneNumber
    ]);
}

function hasSameUser(leftCandidates, rightCandidates) {
    return leftCandidates.some(left => rightCandidates.some(right => areJidsSameUser(left, right)));
}

const jidUtils = {
    normalizeMaybeJid,
    uniqueJids,
    participantJids,
    botJids,
    hasSameUser,
    areJidsSameUser
};

class PluginManager {
    constructor(instanceData = null) {
        this.plugins = new Map();
        this.pluginConfigs = new Map();
        this.pluginsDir = path.join(__dirname, '../plugins');
        this.instanceData = instanceData;
        this.instancePluginConfig = instanceData?.pluginConfig ? 
            (typeof instanceData.pluginConfig === 'string' ? 
                JSON.parse(instanceData.pluginConfig) : instanceData.pluginConfig) 
            : {};
    }

    normalizeInstancePluginConfig(pluginConfig, { strict = false } = {}) {
        const normalizedConfig = {};

        for (const [pluginName, enabled] of Object.entries(pluginConfig || {})) {
            if (!this.plugins.has(pluginName)) {
                if (strict) {
                    throw new Error(`Plugin ${pluginName} not found`);
                }
                logger.warn(`Ignoring unknown plugin configuration: ${pluginName}`);
                continue;
            }

            if (typeof enabled !== 'boolean') {
                if (strict) {
                    throw new Error(`Plugin ${pluginName} enabled state must be boolean`);
                }
                logger.warn(`Ignoring invalid plugin enabled state for ${pluginName}: ${enabled}`);
                continue;
            }

            normalizedConfig[pluginName] = enabled;
        }

        return normalizedConfig;
    }

    async loadPlugins() {
        try {
            const files = fs.readdirSync(this.pluginsDir);
            const pluginFiles = files.filter(file => file.endsWith('.plugin.js'));

            const instanceInfo = this.instanceData ? ` for instance ${this.instanceData.phone}` : ' (global)';
            logger.info(`📦 Loading ${pluginFiles.length} plugins${instanceInfo}...`);

            let enabledCount = 0;
            for (const file of pluginFiles) {
                const pluginName = file.replace('.plugin.js', '');
                const pluginPath = path.join(this.pluginsDir, file);

                try {
                    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?updated=${Date.now()}`);
                    const plugin = pluginModule.default;
                    this.plugins.set(pluginName, plugin);

                    // Use plugin's config if available, otherwise default to enabled
                    const defaultConfig = pluginModule.config || { enabled: true };
                    this.pluginConfigs.set(pluginName, defaultConfig);

                    // Check instance-specific configuration
                    const instanceEnabled = this.instancePluginConfig[pluginName];
                    const actuallyEnabled = instanceEnabled !== undefined ? instanceEnabled : false;
                    if (actuallyEnabled) enabledCount++;

                    const statusText = this.instanceData ? 
                        `Instance: ${actuallyEnabled ? 'enabled' : 'disabled'} (default: ${defaultConfig.enabled})` :
                        `Global default: ${defaultConfig.enabled}`;
                    
                    logger.info(`✅ Loaded plugin: ${pluginName} - ${statusText}${instanceInfo}`);
                } catch (error) {
                    logger.error(`❌ Failed to load plugin ${pluginName}${instanceInfo}: ${error.message}`);
                }
            }

            const statusSummary = this.instanceData ? 
                `${enabledCount}/${this.plugins.size} plugins enabled` :
                `${this.plugins.size} plugins loaded`;
            
            logger.info(`🚀 Plugin loading complete${instanceInfo}. ${statusSummary}.`);
        } catch (error) {
            const instanceInfo = this.instanceData ? ` for instance ${this.instanceData.phone}` : '';
            logger.error(`Error loading plugins${instanceInfo}: ${error.message}`);
        }
    }

    async executePlugins(sock, message) {
        const promises = [];

        for (const [pluginName, plugin] of this.plugins) {
            const defaultConfig = this.pluginConfigs.get(pluginName);
            
            // Check instance-specific configuration first, fall back to default
            const instanceEnabled = this.instancePluginConfig[pluginName];
            const isEnabled = instanceEnabled !== undefined ? instanceEnabled : false; // Default to false for new instances

            if (isEnabled) {
                const instanceInfo = this.instanceData ? ` (Instance: ${this.instanceData.phone})` : '';
                const promise = plugin({
                    props: {
                        ...defaultConfig,
                        enabled: isEnabled,
                        sock,
                        message,
                        instanceData: this.instanceData,
                        jidUtils
                    }
                }).catch(error => {
                    logger.error(`Plugin ${pluginName} error${instanceInfo}: ${error.message}`);
                });

                promises.push(promise);
            }
        }

        // Execute all plugins concurrently
        await Promise.all(promises);
    }

    enablePlugin(pluginName) {
        if (this.plugins.has(pluginName)) {
            this.pluginConfigs.set(pluginName, {
                ...this.pluginConfigs.get(pluginName),
                enabled: true
            });
            logger.info(`✅ Plugin ${pluginName} enabled`);
            return true;
        }
        return false;
    }

    disablePlugin(pluginName) {
        if (this.plugins.has(pluginName)) {
            this.pluginConfigs.set(pluginName, {
                ...this.pluginConfigs.get(pluginName),
                enabled: false
            });
            logger.info(`❌ Plugin ${pluginName} disabled`);
            return true;
        }
        return false;
    }

    getPluginStatus() {
        const status = {};
        for (const [name, config] of this.pluginConfigs) {
            status[name] = config.enabled;
        }
        return status;
    }

    /**
     * Get instance-specific plugin status
     * @returns {Object} Plugin status for this instance
     */
    getInstancePluginStatus() {
        const status = {};
        for (const [pluginName] of this.plugins) {
            const instanceEnabled = this.instancePluginConfig[pluginName];
            status[pluginName] = instanceEnabled !== undefined ? instanceEnabled : false;
        }
        return status;
    }

    /**
     * Enable plugin for this specific instance
     * @param {string} pluginName - Name of the plugin to enable
     * @returns {Object} Updated plugin configuration
     */
    enableInstancePlugin(pluginName) {
        if (this.plugins.has(pluginName)) {
            this.instancePluginConfig[pluginName] = true;
            const instanceInfo = this.instanceData ? ` for instance ${this.instanceData.phone}` : '';
            logger.info(`✅ Plugin ${pluginName} enabled${instanceInfo}`);
            return this.instancePluginConfig;
        }
        throw new Error(`Plugin ${pluginName} not found`);
    }

    /**
     * Disable plugin for this specific instance
     * @param {string} pluginName - Name of the plugin to disable
     * @returns {Object} Updated plugin configuration
     */
    disableInstancePlugin(pluginName) {
        if (this.plugins.has(pluginName)) {
            this.instancePluginConfig[pluginName] = false;
            const instanceInfo = this.instanceData ? ` for instance ${this.instanceData.phone}` : '';
            logger.info(`❌ Plugin ${pluginName} disabled${instanceInfo}`);
            return this.instancePluginConfig;
        }
        throw new Error(`Plugin ${pluginName} not found`);
    }

    /**
     * Set multiple plugin states for this instance
     * @param {Object} pluginConfig - Plugin configuration object
     * @returns {Object} Updated plugin configuration
     */
    setInstancePluginConfig(pluginConfig) {
        const normalizedConfig = this.normalizeInstancePluginConfig(pluginConfig, { strict: true });
        this.instancePluginConfig = { ...this.instancePluginConfig, ...normalizedConfig };
        const instanceInfo = this.instanceData ? ` for instance ${this.instanceData.phone}` : '';
        logger.info(`🔄 Plugin configuration updated${instanceInfo}`);
        return this.instancePluginConfig;
    }

    /**
     * Get list of available plugins
     * @returns {Array} List of plugin names with their default configurations
     */
    getAvailablePlugins() {
        const plugins = [];
        for (const [pluginName, config] of this.pluginConfigs) {
            const instanceEnabled = this.instancePluginConfig[pluginName];
            plugins.push({
                name: pluginName,
                enabled: instanceEnabled !== undefined ? instanceEnabled : false,
                defaultEnabled: config.enabled,
                description: config.description || 'No description available'
            });
        }
        return plugins;
    }

    /**
     * Reload plugin configuration from database
     * @param {Object} freshInstanceData - Updated instance data from database
     */
    syncPluginConfigFromDatabase(freshInstanceData) {
        if (freshInstanceData && freshInstanceData.pluginConfig) {
            const oldConfig = { ...this.instancePluginConfig };
            const freshPluginConfig = typeof freshInstanceData.pluginConfig === 'string' ?
                JSON.parse(freshInstanceData.pluginConfig) : freshInstanceData.pluginConfig;
            this.instancePluginConfig = this.normalizeInstancePluginConfig(freshPluginConfig);
            this.instanceData = freshInstanceData;
            
            const instanceInfo = this.instanceData ? ` for instance ${this.instanceData.phone}` : '';
            logger.info(`🔄 Plugin configuration synced from database${instanceInfo}`);
            
            // Log any changes
            const changes = [];
            for (const [pluginName] of this.plugins) {
                const oldEnabled = oldConfig[pluginName] !== undefined ? oldConfig[pluginName] : false;
                const newEnabled = this.instancePluginConfig[pluginName] !== undefined ? this.instancePluginConfig[pluginName] : false;
                if (oldEnabled !== newEnabled) {
                    changes.push(`${pluginName}: ${oldEnabled ? 'enabled' : 'disabled'} → ${newEnabled ? 'enabled' : 'disabled'}`);
                }
            }
            
            if (changes.length > 0) {
                logger.info(`🔄 Plugin config changes${instanceInfo}: ${changes.join(', ')}`);
            }
            
            return true;
        }
        return false;
    }

    async reloadPlugins() {
        const instanceInfo = this.instanceData ? ` for instance ${this.instanceData.phone}` : '';
        logger.info(`🔄 Reloading plugins${instanceInfo}...`);
        this.plugins.clear();
        await this.loadPlugins();
    }
}

export default PluginManager;
