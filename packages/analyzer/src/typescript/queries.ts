/**
 * Tree-sitter Query(S-expression)。字段名已对照 tree-sitter-typescript@0.23.2 的语法树实测。
 * 以 TS 字符串内联而不是 .scm 文件:tsc 构建不复制非 TS 资源,内联可避免额外的拷贝步骤。
 */
export const IMPORT_QUERY = String.raw`
(import_statement source: (string (string_fragment) @spec)) @import
(export_statement source: (string (string_fragment) @spec)) @reexport
(call_expression function: (import) arguments: (arguments . (string (string_fragment) @spec))) @dynamic
(call_expression
  function: (identifier) @_fn (#eq? @_fn "require")
  arguments: (arguments . (string (string_fragment) @spec))) @require
`;

export const SYMBOL_QUERY = String.raw`
(function_declaration name: (identifier) @name) @function
(generator_function_declaration name: (identifier) @name) @function
(class_declaration name: (type_identifier) @name) @class
(abstract_class_declaration name: (type_identifier) @name) @class
(method_definition name: (property_identifier) @name) @method
(interface_declaration name: (type_identifier) @name) @interface
(type_alias_declaration name: (type_identifier) @name) @type
(enum_declaration name: (identifier) @name) @type
(variable_declarator name: (identifier) @name) @var
`;
