/* istanbul ignore file: these functions are serialised and executed inside the browser, so they must not be instrumented */

const structureFacts = () => ({
  h1: document.querySelectorAll('h1').length,
  lang: document.documentElement.lang,
  viewport: Boolean(document.querySelector('meta[name="viewport"]')),
});

const formIsInvalid = (form) => !form.checkValidity();
const valueMissing = (el) => el.validity.valueMissing;
const fieldFlag = (el, flag) => el.validity[flag];
const fieldIsValid = (el) => el.validity.valid;
const invalidFieldNames = (form) =>
  [...form.elements].filter((el) => el.willValidate && !el.validity.valid).map((el) => el.name || el.id);

module.exports = { structureFacts, formIsInvalid, valueMissing, fieldFlag, fieldIsValid, invalidFieldNames };
