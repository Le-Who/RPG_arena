'use strict';

// GHSA-vfj7-8cjw-p6xm: bound recursion in the parser and every public AST walker.
// This hard limit cannot be disabled through caller-provided parser options.
module.exports = depth => {
  if (depth > 128) {
    const error = new SyntaxError('Brace pattern exceeds the maximum nesting depth of 128');
    error.code = 'ERR_BRACES_DEPTH';
    throw error;
  }
};
