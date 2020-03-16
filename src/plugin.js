import * as bt from '@babel/types';
import fs from 'fs';
import mkdirp from 'mkdirp';
import path from 'path';

import { ALIAS_TO_FUNC_MAP } from './defaults';
import { buildPotData, makePotStr } from './po-helpers';
import { extractPoEntry, getExtractor } from './extract';
import { hasDisablingComment, isInDisabledScope, isOmniImport, isTtagImport,
    hasImportSpecifier, poReferenceComparator, isTtagRequire, isUsingTranslationsCall,
    isComposingRawTranslateHelperCall, extractFuncParamValue, extractFuncDestructVars,
    createFnStub } from './utils';
import { resolveEntries } from './resolve';
import { ValidationError } from './errors';
import TtagContext from './context';
import { isContextTagCall, isValidTagContext, isContextFnCall,
    isValidFnCallContext } from './gettext-context';

let started = false;
export function isStarted() {
    return started;
}

const potEntries = [];

export default function () {
    let context;
    let disabledScopes = new Set();

    function tryMatchTag(cb) {
        return (nodePath, state) => {
            const node = nodePath.node;
            console.log('tryMatchTag _node', node.type/* node, '_context', context, '_nodePath', nodePath*/);
            // console.log('node.tag.object', node.tag.object);
            const _isContextTagCall = isContextTagCall(node, context);
            const _isValidTagContext = isValidTagContext(nodePath);
            console.log('tryMatchTag _isContextTagCall', _isContextTagCall, '_isValidTagContext', _isValidTagContext);
            if (_isContextTagCall && _isValidTagContext) {
                nodePath._C3PO_GETTEXT_CONTEXT = node.tag.object.arguments[0].value;
                nodePath._ORIGINAL_NODE = node;
                nodePath.node = bt.taggedTemplateExpression(node.tag.property, node.quasi);
                nodePath.node.loc = node.loc;
            }
            cb(nodePath, state);
        };
    }

    function tryMatchCall(cb) {
        return (nodePath, state) => {
            const node = nodePath.node;
            console.log('tryMatchCall _node', node.type);
            if (isContextFnCall(node, context) && isValidFnCallContext(nodePath)) {
                nodePath._C3PO_GETTEXT_CONTEXT = node.callee.object.arguments[0].value;
                nodePath._ORIGINAL_NODE = node;
                nodePath.node = bt.callExpression(node.callee.property, node.arguments);
                nodePath.node.loc = node.loc;
            }
            cb(nodePath, state);
        };
    }

    function extractOrResolve(nodePath, state) {
        console.log('extractOrResolve');
        if (isInDisabledScope(nodePath, disabledScopes)) {
            return;
        }

        const extractor = getExtractor(nodePath, context);
        if (!extractor) {
            return;
        }

        const aliases = context.getAliasesForFunc(extractor.name);
        const hasImport = aliases.find(context.hasImport);
        if (!hasImport
            // can be used in scope of context without import
            && !nodePath._C3PO_GETTEXT_CONTEXT) {
            return;
        }

        try {
            try {
                extractor.validate(nodePath.node, context);
            } catch (err) {
                if (err instanceof ValidationError) {
                    context.validationFailureAction(extractor.name, err.message);
                    return;
                }
                throw err;
            }
            if (context.isExtractMode()) {
                const poEntry = extractPoEntry(extractor, nodePath, context, state);
                poEntry && potEntries.push(poEntry);
            }

            if (context.isResolveMode()) {
                resolveEntries(extractor, nodePath, context, state);
            }
        } catch (err) {
            // TODO: handle specific instances of errors
            throw nodePath.buildCodeFrameError(`${err.message}\n${err.stack}`);
        }
    }

    return {
        post() {
            console.log('extractOrResolve post()');

            if (context && context.isExtractMode() && potEntries.length) {
                const poData = buildPotData(potEntries);

                // Here we sort reference entries, this could be useful
                // with conf. options extract.location: 'file' and sortByMsgid
                // which simplifies merge of .po files from different
                // branches of SCM such as git or mercurial.
                const ctxs = Object.keys(poData.translations);
                for (const ctx of ctxs) {
                    const poEntries = poData.translations[ctx];
                    Object.keys(poEntries).forEach((k) => {
                        const poEntry = poEntries[k];
                        // poEntry has a form:
                        // {
                        //     msgid: 'message identifier',
                        //     msgstr: 'translation string',
                        //     comments: {
                        //         reference: 'path/to/file.js:line_number\npath/to/other/file.js:line_number'
                        //     }
                        // }
                        if (poEntry.comments && poEntry.comments.reference) {
                            poEntry.comments.reference = poEntry.comments.reference
                                .split('\n')
                                .sort(poReferenceComparator)
                                .join('\n');
                        }
                    });

                    if (context.isSortedByMsgid()) {
                        const oldPoData = poData.translations[ctx];
                        const newContext = {};
                        const keys = Object.keys(oldPoData).sort();
                        keys.forEach((k) => {
                            newContext[k] = oldPoData[k];
                        });
                        poData.translations[ctx] = newContext;
                    }
                }
                if (context.isSortedByMsgctxt()) {
                    const unorderedTranslations = poData.translations;
                    poData.translations = {};
                    for (const ctx of Object.keys(unorderedTranslations).sort()) {
                        poData.translations[ctx] = unorderedTranslations[ctx];
                    }
                }


                const potStr = makePotStr(poData);
                const filepath = context.getOutputFilepath();
                const dirPath = path.dirname(filepath);
                mkdirp.sync(dirPath);
                fs.writeFileSync(filepath, potStr);
            }
        },
        visitor: {
            /** For t`Sentence to be translated` */
            TaggedTemplateExpression: tryMatchTag(extractOrResolve),
            /** For t("Sentence to be translated") */
            CallExpression: tryMatchCall(extractOrResolve),
            /** For script file start point */
            Program: (nodePath, state) => {
                console.log('Program');

                started = true;
                if (!context) {
                    context = new TtagContext(state.opts);
                } else {
                    context.clear();
                }
                disabledScopes = new Set();
                if (hasDisablingComment(nodePath.node)) {
                    disabledScopes.add(nodePath.scope.uid);
                }
            },
            BlockStatement: (nodePath) => {
                console.log('BlockStatement');
                if (hasDisablingComment(nodePath.node)) {
                    disabledScopes.add(nodePath.scope.uid);
                }
            },
            /** For:
             * const { t } = useTranslations(<namespace>);
             */
            VariableDeclarator: (nodePath, state) => {
                console.log('VariableDeclarator');
                const { node } = nodePath;
                // if (!isTtagRequire(node)) return;
                if (isTtagRequire(node)) {
                    const stubs = [];
                    // require calls
                    node.id.properties
                        .map(({ key: { name: keyName }, value: { name: valueName } }) => [keyName, valueName])
                        .filter(([keyName, valueName]) => {
                            const hasAlias = ALIAS_TO_FUNC_MAP[keyName];
                            if (!hasAlias) {
                                stubs.push(valueName);
                            }
                            return hasAlias;
                        })
                        .forEach(([keyName, valueName]) => {
                            if (keyName !== valueName) { // if alias
                                context.addAlias(ALIAS_TO_FUNC_MAP[keyName], valueName);
                                context.addImport(valueName);
                            } else {
                                context.addImport(keyName);
                            }
                        });
                    if (context.isResolveMode()) {
                        stubs.forEach((stub) => {
                            state.file.path.unshiftContainer('body', createFnStub(stub));
                        });
                        nodePath.remove();
                    }
                } else if (isUsingTranslationsCall(node) || isComposingRawTranslateHelperCall(node)) {
                    const namespaces = extractFuncParamValue(node);
                    const destructVars = extractFuncDestructVars(nodePath);
                    if (destructVars.includes('t')) {
                        // context.addAlias(ALIAS_TO_FUNC_MAP[imported.name], local.name);
                        // context.addImport(local.name);
                        // context.addAlias(ALIAS_TO_FUNC_MAP.t, 't');
                        context.addImport('t');
                        context.setNamespaces(namespaces);
                    }
                    // console.log('useTranslations namespaces node', namespaces, JSON.stringify(node, null, 2), '\n\nnodePath', nodePath, '\n\nstate', state);
                    // console.log('nodePath parent declarations', nodePath.parent.declarations);
                }
            },
            /** For
             * import { useTranslations } from '@oaui/common';
             */
            ImportDeclaration: (nodePath, state) => {
                console.log('ImportDeclaration');
                const { node } = nodePath;
                if (!isOmniImport(node) && !isTtagImport(node)) return;
                if (!context) {
                    context = new TtagContext(state.opts);
                }
                const stubs = [];
                if (hasImportSpecifier(node)) {
                    node.specifiers
                    .filter(bt.isImportSpecifier)
                    .filter(({ imported, local }) => {
                        const hasAlias = ALIAS_TO_FUNC_MAP[imported.name];
                        if (!hasAlias) {
                            stubs.push(local.name);
                        }
                        return hasAlias;
                    })
                    .forEach(({ imported, local }) => {
                        console.log(`context.addAlias(ALIAS_TO_FUNC_MAP[imported.name(${imported.name})], local.name(${local.name}))`);
                        // TODO: Wait until const { t } = useTranslations(); then addAlias
                        context.addAlias(ALIAS_TO_FUNC_MAP[imported.name], local.name);
                        context.addImport(local.name);
                    });
                } else {
                    // throw new Error('You should use ttag imports in form: "import { t } from \'ttag\'"');
                    throw new Error('You should use useTranslations imports in form: "import { useTranslations } from \'@oaui/common\'"');
                }

                if (context.isResolveMode()) {
                    stubs.forEach((stub) => {
                        state.file.path.unshiftContainer('body', createFnStub(stub));
                    });
                    nodePath.remove();
                }
            },
        },
    };
}
