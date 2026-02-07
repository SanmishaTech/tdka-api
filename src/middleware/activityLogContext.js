const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

const withRequestContext = (req, res, next) => {
  als.run({ req }, () => next());
};

const getRequestFromContext = () => {
  const store = als.getStore();
  return store?.req || null;
};

module.exports = {
  withRequestContext,
  getRequestFromContext,
};
