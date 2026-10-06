// Test-only dummy language model; never used to answer @acp requests.
const vscode = require('vscode');

exports.activate = function (context) {
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('acp-test', {
    provideLanguageModelChatInformation() {
      return [{
        id: 'acp-test-model', name: 'ACP Test Model', family: 'acp-test', version: '1',
        maxInputTokens: 100000, maxOutputTokens: 4096,
        capabilities: { toolCalling: true, imageInput: false },
        isUserSelectable: true, isDefault: true,
      }];
    },
    async provideLanguageModelChatResponse(_model, _messages, _options, progress) {
      progress.report(new vscode.LanguageModelTextPart('(fake model)'));
    },
    async provideTokenCount(_model, text) {
      return typeof text === 'string' ? text.length : 1;
    },
  }));
};
