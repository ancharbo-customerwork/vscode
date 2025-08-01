/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ILocalMcpServer, IMcpManagementService, IGalleryMcpServer, InstallOptions, InstallMcpServerEvent, UninstallMcpServerEvent, DidUninstallMcpServerEvent, InstallMcpServerResult, IMcpServer, IMcpGalleryService, UninstallOptions } from '../../../../platform/mcp/common/mcpManagement.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IMcpResourceScannerService, McpResourceTarget } from '../../../../platform/mcp/common/mcpResourceScannerService.js';
import { isWorkspaceFolder, IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../platform/workspace/common/workspace.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { MCP_CONFIGURATION_KEY, WORKSPACE_STANDALONE_CONFIGURATIONS } from '../../configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { URI } from '../../../../base/common/uri.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { McpManagementChannelClient } from '../../../../platform/mcp/common/mcpManagementIpc.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IRemoteUserDataProfilesService } from '../../userDataProfile/common/remoteUserDataProfiles.js';
import { AbstractMcpManagementService, ILocalMcpServerInfo } from '../../../../platform/mcp/common/mcpManagementService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ResourceMap } from '../../../../base/common/map.js';

export interface IWorkbencMcpServerInstallOptions extends InstallOptions {
	target?: ConfigurationTarget | IWorkspaceFolder;
}

export const enum LocalMcpServerScope {
	User = 'user',
	RemoteUser = 'remoteUser',
	Workspace = 'workspace',
}

export interface IWorkbenchLocalMcpServer extends ILocalMcpServer {
	readonly scope?: LocalMcpServerScope;
}

export interface IWorkbenchMcpServerInstallResult extends InstallMcpServerResult {
	readonly local?: IWorkbenchLocalMcpServer;
}

export interface IWorkbenchMcpManagementService extends IMcpManagementService {

	readonly onDidInstallMcpServers: Event<readonly IWorkbenchMcpServerInstallResult[]>;

	readonly onInstallMcpServerInCurrentProfile: Event<InstallMcpServerEvent>;
	readonly onDidInstallMcpServersInCurrentProfile: Event<readonly IWorkbenchMcpServerInstallResult[]>;
	readonly onUninstallMcpServerInCurrentProfile: Event<UninstallMcpServerEvent>;
	readonly onDidUninstallMcpServerInCurrentProfile: Event<DidUninstallMcpServerEvent>;

	getInstalled(): Promise<IWorkbenchLocalMcpServer[]>;
	install(server: IMcpServer, options?: IWorkbencMcpServerInstallOptions): Promise<IWorkbenchLocalMcpServer>;
}

export const IWorkbenchMcpManagementService = createDecorator<IWorkbenchMcpManagementService>('workbenchMcpManagementService');

class WorkbenchMcpManagementService extends Disposable implements IWorkbenchMcpManagementService {

	readonly _serviceBrand: undefined;

	private _onInstallMcpServer = this._register(new Emitter<InstallMcpServerEvent>());
	readonly onInstallMcpServer = this._onInstallMcpServer.event;

	private _onDidInstallMcpServers = this._register(new Emitter<readonly IWorkbenchMcpServerInstallResult[]>());
	readonly onDidInstallMcpServers = this._onDidInstallMcpServers.event;

	private _onUninstallMcpServer = this._register(new Emitter<UninstallMcpServerEvent>());
	readonly onUninstallMcpServer = this._onUninstallMcpServer.event;

	private _onDidUninstallMcpServer = this._register(new Emitter<DidUninstallMcpServerEvent>());
	readonly onDidUninstallMcpServer = this._onDidUninstallMcpServer.event;

	private readonly _onInstallMcpServerInCurrentProfile = this._register(new Emitter<InstallMcpServerEvent>());
	readonly onInstallMcpServerInCurrentProfile = this._onInstallMcpServerInCurrentProfile.event;

	private readonly _onDidInstallMcpServersInCurrentProfile = this._register(new Emitter<readonly IWorkbenchMcpServerInstallResult[]>());
	readonly onDidInstallMcpServersInCurrentProfile = this._onDidInstallMcpServersInCurrentProfile.event;

	private readonly _onUninstallMcpServerInCurrentProfile = this._register(new Emitter<UninstallMcpServerEvent>());
	readonly onUninstallMcpServerInCurrentProfile = this._onUninstallMcpServerInCurrentProfile.event;

	private readonly _onDidUninstallMcpServerInCurrentProfile = this._register(new Emitter<DidUninstallMcpServerEvent>());
	readonly onDidUninstallMcpServerInCurrentProfile = this._onDidUninstallMcpServerInCurrentProfile.event;

	private readonly workspaceMcpManagementService: IMcpManagementService;
	private readonly remoteMcpManagementService: IMcpManagementService | undefined;

	constructor(
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IMcpManagementService private readonly mcpManagementService: IMcpManagementService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IRemoteUserDataProfilesService private readonly remoteUserDataProfilesService: IRemoteUserDataProfilesService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this.workspaceMcpManagementService = this._register(instantiationService.createInstance(WorkspaceMcpManagementService));
		const remoteAgentConnection = remoteAgentService.getConnection();
		if (remoteAgentConnection) {
			this.remoteMcpManagementService = this._register(new McpManagementChannelClient(remoteAgentConnection.getChannel<IChannel>('mcpManagement')));
		}

		this._register(this.mcpManagementService.onInstallMcpServer(e => {
			this._onInstallMcpServer.fire(e);
			if (uriIdentityService.extUri.isEqual(e.mcpResource, this.userDataProfileService.currentProfile.mcpResource)) {
				this._onInstallMcpServerInCurrentProfile.fire(e);
			}
		}));

		this._register(this.mcpManagementService.onDidInstallMcpServers(e => {
			const mcpServerInstallResult: IWorkbenchMcpServerInstallResult[] = [];
			const mcpServerInstallResultInCurrentProfile: IWorkbenchMcpServerInstallResult[] = [];
			for (const result of e) {
				const workbenchResult = {
					...result,
					local: result.local ? this.toWorkspaceMcpServer(result.local, LocalMcpServerScope.User) : undefined
				};
				mcpServerInstallResult.push(workbenchResult);
				if (uriIdentityService.extUri.isEqual(result.mcpResource, this.userDataProfileService.currentProfile.mcpResource)) {
					mcpServerInstallResultInCurrentProfile.push(workbenchResult);
				}
			}

			this._onDidInstallMcpServers.fire(mcpServerInstallResult);
			if (mcpServerInstallResultInCurrentProfile.length) {
				this._onDidInstallMcpServersInCurrentProfile.fire(mcpServerInstallResultInCurrentProfile);
			}
		}));

		this._register(this.mcpManagementService.onUninstallMcpServer(e => {
			this._onUninstallMcpServer.fire(e);
			if (uriIdentityService.extUri.isEqual(e.mcpResource, this.userDataProfileService.currentProfile.mcpResource)) {
				this._onUninstallMcpServerInCurrentProfile.fire(e);
			}
		}));

		this._register(this.mcpManagementService.onDidUninstallMcpServer(e => {
			this._onDidUninstallMcpServer.fire(e);
			if (uriIdentityService.extUri.isEqual(e.mcpResource, this.userDataProfileService.currentProfile.mcpResource)) {
				this._onDidUninstallMcpServerInCurrentProfile.fire(e);
			}
		}));

		this._register(this.workspaceMcpManagementService.onInstallMcpServer(async e => {
			this._onInstallMcpServer.fire(e);
			this._onInstallMcpServerInCurrentProfile.fire(e);
		}));

		this._register(this.workspaceMcpManagementService.onDidInstallMcpServers(async e => {
			const mcpServerInstallResult: IWorkbenchMcpServerInstallResult[] = [];
			for (const result of e) {
				const workbenchResult = {
					...result,
					local: result.local ? this.toWorkspaceMcpServer(result.local, LocalMcpServerScope.Workspace) : undefined
				};
				mcpServerInstallResult.push(workbenchResult);
			}
			this._onDidInstallMcpServersInCurrentProfile.fire(mcpServerInstallResult);
			this._onDidInstallMcpServersInCurrentProfile.fire(mcpServerInstallResult);
		}));

		this._register(this.workspaceMcpManagementService.onUninstallMcpServer(async e => {
			this._onUninstallMcpServer.fire(e);
			this._onUninstallMcpServerInCurrentProfile.fire(e);
		}));

		this._register(this.workspaceMcpManagementService.onDidUninstallMcpServer(async e => {
			this._onDidUninstallMcpServer.fire(e);
			this._onDidUninstallMcpServerInCurrentProfile.fire(e);
		}));

		if (this.remoteMcpManagementService) {
			this._register(this.remoteMcpManagementService.onInstallMcpServer(async e => {
				this._onInstallMcpServer.fire(e);
				const remoteMcpResource = await this.getRemoteMcpResource(this.userDataProfileService.currentProfile.mcpResource);
				if (remoteMcpResource ? uriIdentityService.extUri.isEqual(e.mcpResource, remoteMcpResource) : this.userDataProfileService.currentProfile.isDefault) {
					this._onInstallMcpServerInCurrentProfile.fire(e);
				}
			}));

			this._register(this.remoteMcpManagementService.onDidInstallMcpServers(async e => {
				const mcpServerInstallResult: IWorkbenchMcpServerInstallResult[] = [];
				const mcpServerInstallResultInCurrentProfile: IWorkbenchMcpServerInstallResult[] = [];
				const remoteMcpResource = await this.getRemoteMcpResource(this.userDataProfileService.currentProfile.mcpResource);
				for (const result of e) {
					const workbenchResult = {
						...result,
						local: result.local ? this.toWorkspaceMcpServer(result.local, LocalMcpServerScope.RemoteUser) : undefined
					};
					mcpServerInstallResult.push(workbenchResult);
					if (remoteMcpResource ? uriIdentityService.extUri.isEqual(result.mcpResource, remoteMcpResource) : this.userDataProfileService.currentProfile.isDefault) {
						mcpServerInstallResultInCurrentProfile.push(workbenchResult);
					}
				}

				this._onDidInstallMcpServersInCurrentProfile.fire(mcpServerInstallResult);
				if (mcpServerInstallResultInCurrentProfile.length) {
					this._onDidInstallMcpServersInCurrentProfile.fire(mcpServerInstallResultInCurrentProfile);
				}
			}));

			this._register(this.remoteMcpManagementService.onUninstallMcpServer(async e => {
				this._onUninstallMcpServer.fire(e);
				const remoteMcpResource = await this.getRemoteMcpResource(this.userDataProfileService.currentProfile.mcpResource);
				if (remoteMcpResource ? uriIdentityService.extUri.isEqual(e.mcpResource, remoteMcpResource) : this.userDataProfileService.currentProfile.isDefault) {
					this._onUninstallMcpServerInCurrentProfile.fire(e);
				}
			}));

			this._register(this.remoteMcpManagementService.onDidUninstallMcpServer(async e => {
				this._onDidUninstallMcpServer.fire(e);
				const remoteMcpResource = await this.getRemoteMcpResource(this.userDataProfileService.currentProfile.mcpResource);
				if (remoteMcpResource ? uriIdentityService.extUri.isEqual(e.mcpResource, remoteMcpResource) : this.userDataProfileService.currentProfile.isDefault) {
					this._onDidUninstallMcpServerInCurrentProfile.fire(e);
				}
			}));
		}
	}

	async getInstalled(): Promise<IWorkbenchLocalMcpServer[]> {
		const installed: IWorkbenchLocalMcpServer[] = [];
		const [userServers, remoteServers, workspaceServers] = await Promise.all([
			this.mcpManagementService.getInstalled(this.userDataProfileService.currentProfile.mcpResource),
			this.remoteMcpManagementService?.getInstalled(await this.getRemoteMcpResource()) ?? Promise.resolve<ILocalMcpServer[]>([]),
			this.workspaceMcpManagementService?.getInstalled() ?? Promise.resolve<ILocalMcpServer[]>([]),
		]);

		for (const server of userServers) {
			installed.push(this.toWorkspaceMcpServer(server, LocalMcpServerScope.User));
		}
		for (const server of remoteServers) {
			installed.push(this.toWorkspaceMcpServer(server, LocalMcpServerScope.RemoteUser));
		}
		for (const server of workspaceServers) {
			installed.push(this.toWorkspaceMcpServer(server, LocalMcpServerScope.Workspace));
		}

		return installed;
	}

	private toWorkspaceMcpServer(server: ILocalMcpServer, scope: LocalMcpServerScope): IWorkbenchLocalMcpServer {
		return { ...server, scope };
	}

	async install(server: IMcpServer, options?: IWorkbencMcpServerInstallOptions): Promise<IWorkbenchLocalMcpServer> {
		options = options ?? {};

		if (options.target === ConfigurationTarget.WORKSPACE || isWorkspaceFolder(options.target)) {
			const mcpResource = options.target === ConfigurationTarget.WORKSPACE ? this.workspaceContextService.getWorkspace().configuration : options.target.toResource(WORKSPACE_STANDALONE_CONFIGURATIONS[MCP_CONFIGURATION_KEY]);
			if (!mcpResource) {
				throw new Error(`Illegal target: ${options.target}`);
			}
			options.mcpResource = mcpResource;
			return this.workspaceMcpManagementService.install(server, options);
		}

		if (options.target === ConfigurationTarget.USER_REMOTE) {
			if (!this.remoteMcpManagementService) {
				throw new Error(`Illegal target: ${options.target}`);
			}
			options.mcpResource = await this.getRemoteMcpResource(options.mcpResource);
			return this.remoteMcpManagementService.install(server, options);
		}

		if (options.target && options.target !== ConfigurationTarget.USER && options.target !== ConfigurationTarget.USER_LOCAL) {
			throw new Error(`Illegal target: ${options.target}`);
		}

		options.mcpResource = this.userDataProfileService.currentProfile.mcpResource;
		return this.mcpManagementService.install(server, options);
	}

	installFromGallery(server: IGalleryMcpServer, options?: InstallOptions): Promise<ILocalMcpServer> {
		options = options ?? {};
		if (!options.mcpResource) {
			options.mcpResource = this.userDataProfileService.currentProfile.mcpResource;
		}
		return this.mcpManagementService.installFromGallery(server, options);
	}

	async uninstall(server: IWorkbenchLocalMcpServer): Promise<void> {
		if (server.scope === LocalMcpServerScope.Workspace) {
			return this.workspaceMcpManagementService.uninstall(server);
		}

		if (server.scope === LocalMcpServerScope.RemoteUser) {
			if (!this.remoteMcpManagementService) {
				throw new Error(`Illegal target: ${server.scope}`);
			}
			return this.remoteMcpManagementService.uninstall(server);
		}

		return this.mcpManagementService.uninstall(server, { mcpResource: this.userDataProfileService.currentProfile.mcpResource });
	}

	private async getRemoteMcpResource(mcpResource?: URI): Promise<URI | undefined> {
		if (!mcpResource && this.userDataProfileService.currentProfile.isDefault) {
			return undefined;
		}
		mcpResource = mcpResource ?? this.userDataProfileService.currentProfile.mcpResource;
		let profile = this.userDataProfilesService.profiles.find(p => this.uriIdentityService.extUri.isEqual(p.mcpResource, mcpResource));
		if (profile) {
			profile = await this.remoteUserDataProfilesService.getRemoteProfile(profile);
		} else {
			profile = (await this.remoteUserDataProfilesService.getRemoteProfiles()).find(p => this.uriIdentityService.extUri.isEqual(p.extensionsResource, mcpResource));
		}
		return profile?.extensionsResource;
	}
}

class WorkspaceMcpResourceManagementService extends AbstractMcpManagementService {

	constructor(
		target: McpResourceTarget,
		private readonly mcpResource: URI,
		@IMcpGalleryService mcpGalleryService: IMcpGalleryService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ILogService logService: ILogService,
		@IMcpResourceScannerService mcpResourceScannerService: IMcpResourceScannerService,
	) {
		super(target, mcpGalleryService, fileService, uriIdentityService, logService, mcpResourceScannerService);
	}

	protected getDefaultMcpResource(): URI {
		return this.mcpResource;
	}

	override installFromGallery(): Promise<ILocalMcpServer> {
		throw new Error('Not supported');
	}

	protected override async getLocalMcpServerInfo(): Promise<ILocalMcpServerInfo | undefined> {
		return undefined;
	}

}

class WorkspaceMcpManagementService extends Disposable implements IMcpManagementService {

	readonly _serviceBrand: undefined;

	private readonly _onInstallMcpServer = this._register(new Emitter<InstallMcpServerEvent>());
	readonly onInstallMcpServer = this._onInstallMcpServer.event;

	private readonly _onDidInstallMcpServers = this._register(new Emitter<readonly InstallMcpServerResult[]>());
	readonly onDidInstallMcpServers = this._onDidInstallMcpServers.event;

	private readonly _onUninstallMcpServer = this._register(new Emitter<UninstallMcpServerEvent>());
	readonly onUninstallMcpServer = this._onUninstallMcpServer.event;

	private readonly _onDidUninstallMcpServer = this._register(new Emitter<DidUninstallMcpServerEvent>());
	readonly onDidUninstallMcpServer = this._onDidUninstallMcpServer.event;

	private allMcpServers: ILocalMcpServer[] = [];

	private workspaceConfiguration?: URI | null;
	private readonly workspaceMcpManagementServices = new ResourceMap<{ service: IMcpManagementService } & IDisposable>();

	constructor(
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.initialize();
	}

	private async initialize(): Promise<void> {
		try {
			await this.onDidChangeWorkbenchState();
			await this.onDidChangeWorkspaceFolders({ added: this.workspaceContextService.getWorkspace().folders, removed: [], changed: [] });
			this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => this.onDidChangeWorkspaceFolders(e)));
			this._register(this.workspaceContextService.onDidChangeWorkbenchState(e => this.onDidChangeWorkbenchState()));
		} catch (error) {
			this.logService.error('Failed to initialize workspace folders', error);
		}
	}

	private async onDidChangeWorkbenchState(): Promise<void> {
		if (this.workspaceConfiguration) {
			await this.removeWorkspaceService(this.workspaceConfiguration);
		}
		this.workspaceConfiguration = this.workspaceContextService.getWorkspace().configuration;
		if (this.workspaceConfiguration) {
			await this.addWorkspaceService(this.workspaceConfiguration, ConfigurationTarget.WORKSPACE);
		}
	}

	private async onDidChangeWorkspaceFolders(e: IWorkspaceFoldersChangeEvent): Promise<void> {
		try {
			await Promise.allSettled(e.removed.map(folder => this.removeWorkspaceService(folder.toResource(WORKSPACE_STANDALONE_CONFIGURATIONS[MCP_CONFIGURATION_KEY]))));
		} catch (error) {
			this.logService.error(error);
		}
		try {
			await Promise.allSettled(e.added.map(folder => this.addWorkspaceService(folder.toResource(WORKSPACE_STANDALONE_CONFIGURATIONS[MCP_CONFIGURATION_KEY]), ConfigurationTarget.WORKSPACE_FOLDER)));
		} catch (error) {
			this.logService.error(error);
		}
	}

	private async addWorkspaceService(mcpResource: URI, target: McpResourceTarget): Promise<void> {
		if (this.workspaceMcpManagementServices.has(mcpResource)) {
			return;
		}

		const disposables = new DisposableStore();
		const service = disposables.add(this.instantiationService.createInstance(WorkspaceMcpResourceManagementService, target, mcpResource));

		try {
			const installedServers = await service.getInstalled();
			this.allMcpServers.push(...installedServers);
			if (installedServers.length > 0) {
				const installResults: InstallMcpServerResult[] = installedServers.map(server => ({
					name: server.name,
					local: server,
					mcpResource: server.mcpResource
				}));
				this._onDidInstallMcpServers.fire(installResults);
			}
		} catch (error) {
			this.logService.warn('Failed to get installed servers from', mcpResource.toString(), error);
		}

		disposables.add(service.onInstallMcpServer(e => this._onInstallMcpServer.fire(e)));
		disposables.add(service.onDidInstallMcpServers(e => {
			for (const { local } of e) {
				if (local) {
					this.allMcpServers.push(local);
				}
			}
			this._onDidInstallMcpServers.fire(e);
		}));
		disposables.add(service.onUninstallMcpServer(e => this._onUninstallMcpServer.fire(e)));
		disposables.add(service.onDidUninstallMcpServer(e => {
			const index = this.allMcpServers.findIndex(server => this.uriIdentityService.extUri.isEqual(server.mcpResource, e.mcpResource) && server.name === e.name);
			if (index !== -1) {
				this.allMcpServers.splice(index, 1);
				this._onDidUninstallMcpServer.fire(e);
			}
		}));
		this.workspaceMcpManagementServices.set(mcpResource, { service, dispose: () => disposables.dispose() });
	}

	private async removeWorkspaceService(mcpResource: URI): Promise<void> {
		const serviceItem = this.workspaceMcpManagementServices.get(mcpResource);
		if (serviceItem) {
			try {
				const installedServers = await serviceItem.service.getInstalled();
				this.allMcpServers = this.allMcpServers.filter(server => !installedServers.some(uninstalled => this.uriIdentityService.extUri.isEqual(uninstalled.mcpResource, server.mcpResource)));
				for (const server of installedServers) {
					this._onDidUninstallMcpServer.fire({
						name: server.name,
						mcpResource: server.mcpResource
					});
				}
			} catch (error) {
				this.logService.warn('Failed to get installed servers from', mcpResource.toString(), error);
			}
			this.workspaceMcpManagementServices.delete(mcpResource);
			serviceItem.dispose();
		}
	}

	async getInstalled(): Promise<ILocalMcpServer[]> {
		return this.allMcpServers;
	}

	async install(server: IMcpServer, options?: InstallOptions): Promise<ILocalMcpServer> {
		if (!options?.mcpResource) {
			throw new Error('MCP resource is required');
		}

		const mcpManagementServiceItem = this.workspaceMcpManagementServices.get(options?.mcpResource);
		if (!mcpManagementServiceItem) {
			throw new Error(`No MCP management service found for resource: ${options?.mcpResource.toString()}`);
		}

		return mcpManagementServiceItem.service.install(server, options);
	}

	async uninstall(server: ILocalMcpServer, options?: UninstallOptions): Promise<void> {
		const mcpResource = server.mcpResource;

		const mcpManagementServiceItem = this.workspaceMcpManagementServices.get(mcpResource);
		if (!mcpManagementServiceItem) {
			throw new Error(`No MCP management service found for resource: ${mcpResource.toString()}`);
		}

		return mcpManagementServiceItem.service.uninstall(server, options);
	}

	async installFromGallery(): Promise<ILocalMcpServer> {
		throw new Error('Not supported');
	}

	override dispose(): void {
		this.workspaceMcpManagementServices.forEach(service => service.dispose());
		this.workspaceMcpManagementServices.clear();
		super.dispose();
	}
}

registerSingleton(IWorkbenchMcpManagementService, WorkbenchMcpManagementService, InstantiationType.Delayed);
