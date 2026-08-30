
JSDoc을 영문으로 작성하세요. 모든 함수에
```js
/**
 * Short description of the function or method.
 *
 * Longer explanation of what the function does, how it works, 
 * and any important edge cases or side effects.
 *
 * @async (Optional)
 * @param {Type} paramName - Description of the parameter.
 * @param {Type} [optionalParamName=defaultValue] - Description of an optional parameter with default.
 * @returns {ReturnType} Description of the return value.
 * @throws {ErrorType} Description of errors that can be thrown.
 * 
 * @example
 * const result = myFunction('example');
 * console.log(result); // Expected output
 */
```

자잘한 주석은 작성하지 않습니다.
이런 내용도 주석을 작성합니다.
```js
const a = 10; /** This is a constant value used for calculations. */
```