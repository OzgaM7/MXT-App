// Generuje hash bcrypt dla podanego hasła: npm run hash -- "MojeHaslo"
'use strict';
const bcrypt = require('bcryptjs');
const pass = process.argv[2];
if (!pass) { console.error('Użycie: npm run hash -- "hasło"'); process.exit(1); }
console.log(bcrypt.hashSync(pass, 12));
