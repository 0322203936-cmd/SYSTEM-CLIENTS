import jwt from 'jsonwebtoken';

const token = jwt.sign(
  { id: 1, role: 'admin', username: 'admin' },
  'cambia-esta-clave-en-produccion'
);

fetch('http://localhost:3000/api/credits/sync', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  }
}).then(res => res.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));
