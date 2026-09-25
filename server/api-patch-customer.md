# Wire customer API into api.js

At the top of `server/api.js` add:
```js
const { mountCustomerRoutes } = require('./customer-api');
```

Inside `module.exports = function buildApi(io) {` after `const r = express.Router();` add:
```js
mountCustomerRoutes(r, io);
```

If this file exists, the server may already load customer-api via a require in buildApi — check api.js.
