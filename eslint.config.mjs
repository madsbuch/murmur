import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'test-results/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-expect-error': true, 'ts-nocheck': true, 'ts-check': false }],
      '@typescript-eslint/strict-boolean-expressions': ['error', { allowString: false, allowNumber: false, allowNullableObject: false, allowNullableBoolean: false, allowNullableString: false, allowNullableNumber: false, allowAny: false }],
      '@typescript-eslint/restrict-plus-operands': ['error', { allowAny: false, allowBoolean: false, allowNullish: false, allowNumberAndString: false, allowRegExp: false }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowAny: false, allowBoolean: false, allowNullish: false, allowNumber: false, allowRegExp: false, allowNever: false }],
      'eqeqeq': ['error', 'always'],
      'no-implicit-coercion': 'error',
      'no-new-wrappers': 'error',
      'no-bitwise': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'CallExpression[callee.name=/^(String|Number|Boolean)$/]', message: 'Validate unknown input; use an explicit typed conversion instead of a coercing constructor.' },
        { selector: 'PropertyDefinition[definite=true]', message: 'Initialize fields instead of using definite assignment assertions.' },
        { selector: 'VariableDeclarator[definite=true]', message: 'Initialize variables instead of using definite assignment assertions.' },
        { selector: 'CallExpression[typeArguments][callee.property.name=/^(querySelector|querySelectorAll|closest)$/]', message: 'Check DOM element types with instanceof instead of asserting a generic return type.' },
      ],
    },
  },
);
