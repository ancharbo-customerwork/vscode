/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatWidget, showChatView } from '../../../../../chat.js';
import { URI } from '../../../../../../../../../base/common/uri.js';
import { ACTION_ID_NEW_CHAT } from '../../../../chatClearActions.js';
import { extUri } from '../../../../../../../../../base/common/resources.js';
import { assertDefined } from '../../../../../../../../../base/common/types.js';
import { IChatAttachPromptActionOptions } from '../../../chatAttachPromptAction.js';
import { IViewsService } from '../../../../../../../../services/views/common/viewsService.js';
import { ICommandService } from '../../../../../../../../../platform/commands/common/commands.js';

/**
 * Options for the {@link attachInstructionsFile} function.
 */
export interface IAttachOptions {
	/**
	 * Chat widget instance to attach the prompt to.
	 */
	readonly widget?: IChatWidget;
	/**
	 * Whether to create a new chat session and
	 * attach the prompt to it.
	 */
	readonly inNewChat?: boolean;

	/**
	 * Whether to skip attaching provided prompt if it is
	 * already attached as an implicit  "current file" context.
	 */
	readonly skipIfImplicitlyAttached?: boolean;

	readonly viewsService: IViewsService;
	readonly commandService: ICommandService;
}

/**
 * Return value of the {@link attachInstructionsFile} function.
 */
interface IAttachResult {
	readonly widget: IChatWidget;
	readonly wasAlreadyAttached: boolean;
}

/**
 * Check if provided uri is already attached to chat
 * input as an implicit  "current file" context.
 */
const isAttachedAsCurrentPrompt = (
	promptUri: URI,
	widget: IChatWidget,
): boolean => {
	const { implicitContext } = widget.input;
	if (implicitContext === undefined) {
		return false;
	}

	if (implicitContext.isPrompt === false) {
		return false;
	}

	if (implicitContext.enabled === false) {
		return false;
	}

	assertDefined(
		implicitContext.value,
		'Prompt value must always be defined.',
	);

	const uri = URI.isUri(implicitContext.value)
		? implicitContext.value
		: implicitContext.value.uri;

	return extUri.isEqual(promptUri, uri);
};

/**
 * Attaches provided prompts to a chat input.
 */
export const attachInstructionsFile = async (
	file: URI,
	options: IAttachOptions,
): Promise<IAttachResult> => {
	const { skipIfImplicitlyAttached } = options;

	const widget = await getChatWidgetObject(options);

	if (skipIfImplicitlyAttached && isAttachedAsCurrentPrompt(file, widget)) {
		return { widget, wasAlreadyAttached: true };
	}

	const wasAlreadyAttached = widget
		.attachmentModel
		.promptInstructions
		.add(file);

	return { widget, wasAlreadyAttached };
};

/**
 * Gets a chat widget based on the provided {@link IChatAttachPromptActionOptions.widget widget}
 * reference and the `inNewChat` flag.
 *
 * @throws if failed to reveal a chat widget.
 */
const getChatWidgetObject = async (
	options: IAttachOptions,
): Promise<IChatWidget> => {
	const { widget, inNewChat } = options;

	// if a new chat sessions needs to be created, or there is no
	// chat widget reference provided, show a chat view, otherwise
	// re-use the existing chat widget
	if ((inNewChat === true) || (widget === undefined)) {
		return await showChat(options, inNewChat);
	}

	return widget;
};

/**
 * Opens a chat session, or reveals an existing one.
 */
const showChat = async (
	options: IAttachOptions,
	createNew: boolean = false,
): Promise<IChatWidget> => {
	const { commandService, viewsService } = options;

	if (createNew === true) {
		await commandService.executeCommand(ACTION_ID_NEW_CHAT);
	}

	const widget = await showChatView(viewsService);

	assertDefined(
		widget,
		'Chat widget must be defined.',
	);

	return widget;
};
