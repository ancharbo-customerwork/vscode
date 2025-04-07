/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SingleTextEdit } from '../../../../common/core/textEdit.js';
import { Command } from '../../../../common/languages.js';
import { InlineSuggestionItem } from './inlineSuggestionItem.js';

export class InlineEdit {
	constructor(
		public readonly edit: SingleTextEdit,
		public readonly commands: readonly Command[],
		public readonly inlineCompletion: InlineSuggestionItem,
	) { }

	public get range() {
		return this.edit.range;
	}

	public get text() {
		return this.edit.text;
	}

	public equals(other: InlineEdit): boolean {
		return this.edit.equals(other.edit)
			&& this.inlineCompletion === other.inlineCompletion;
	}
}
