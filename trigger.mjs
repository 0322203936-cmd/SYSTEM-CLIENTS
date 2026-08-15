import jwt from 'jsonwebtoken';

const token = jwt.sign(
  { id: 1, role: 'admin', username: 'admin' },
  'fc_2026_7Zp4mQ9xR2vK8nL5sD1wH6cB3tY0gF'
);

fetch('http://localhost:3000/api/credits/sync', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  }
}).then(res => res.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));
