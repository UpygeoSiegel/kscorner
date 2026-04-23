const express = require('express');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin initialized with service account key.');
} else {
  console.warn('FIREBASE_SERVICE_ACCOUNT_KEY not found in .env. Firebase Admin not initialized.');
}

const db = admin.apps.length ? admin.firestore() : null;

// Authentication Middleware
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Assign role based on email
    const counselorEmails = ['lkamara@uppublicschools.org', 'siegel.benjamin1@gmail.com'];
    decodedToken.role = counselorEmails.includes(decodedToken.email) ? 'counselor' : 'student';
    
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    res.status(401).json({ message: 'Unauthorized: Invalid token' });
  }
};

// Counselor-only Middleware
const isCounselor = (req, res, next) => {
  if (req.user.role !== 'counselor') {
    return res.status(403).json({ message: 'Forbidden: Counselor access only' });
  }
  next();
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get all appointments (Counselor sees all, Student sees theirs)
app.get('/api/appointments', authenticate, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
  
  try {
    let query = db.collection('appointments');
    if (req.user.role === 'student') {
      const snapshot = await query.get();
      const appts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      const filtered = appts.filter(a => a.status === 'Approved' || a.email === req.user.email);
      return res.json(filtered);
    } else {
      const snapshot = await query.get();
      const appts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(appts);
    }
  } catch (error) {
    console.error('Error fetching appointments:', error);
    res.status(500).json({ message: 'Error fetching appointments' });
  }
});

// Book an appointment
app.post('/api/book-appointment', authenticate, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
  
  const { name, cls, reason, day, time } = req.body;
  
  try {
    // Check if slot is already taken or requested
    const existingSnapshot = await db.collection('appointments')
      .where('day', '==', day)
      .where('time', '==', time)
      .where('status', 'in', ['Pending', 'Approved'])
      .get();
    
    if (!existingSnapshot.empty) {
      return res.status(400).json({ message: 'This time slot is already requested or booked.' });
    }

    const docRef = await db.collection('appointments').add({
      uid: req.user.uid,
      email: req.user.email,
      name,
      cls,
      reason,
      day,
      time,
      status: 'Pending',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    res.status(200).json({ id: docRef.id, message: 'Request sent successfully' });
  } catch (error) {
    console.error('Error booking appointment:', error);
    res.status(500).json({ message: 'Error booking appointment' });
  }
});

// Manual appointment creation (Counselor only)
app.post('/api/manual-appointment', authenticate, isCounselor, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
  const { name, email, cls, reason, day, time } = req.body;
  try {
    const docRef = await db.collection('appointments').add({
      name,
      email,
      cls: cls || 'Manual Entry',
      reason: reason || 'Counselor Scheduled',
      day,
      time,
      status: 'Approved',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    res.status(200).json({ id: docRef.id });
  } catch (error) {
    res.status(500).json({ message: 'Error creating manual appointment' });
  }
});

// Edit appointment (Counselor only)
app.post('/api/edit-appointment/:id', authenticate, isCounselor, async (req, res) => {
    if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
    const { id } = req.params;
    const { name, email, cls, reason, day, time } = req.body;
    try {
      await db.collection('appointments').doc(id).update({ name, email, cls, reason, day, time });
      res.status(200).json({ message: 'Appointment updated' });
    } catch (error) {
      res.status(500).json({ message: 'Error updating appointment' });
    }
  });

// Update appointment status (Counselor only)
app.post('/api/update-appointment/:id', authenticate, isCounselor, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
  
  const { status } = req.body;
  const { id } = req.params;
  
  try {
    await db.collection('appointments').doc(id).update({ status });
    res.status(200).json({ message: 'Status updated' });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ message: 'Error updating status' });
  }
});

// Get all summons
app.get('/api/summons', authenticate, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
  try {
    const snapshot = await db.collection('summons').get();
    const summons = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(summons);
  } catch (error) {
    console.error('Error fetching summons:', error);
    res.status(500).json({ message: 'Error fetching summons' });
  }
});

// Send a summon (Counselor only)
app.post('/api/send-summon', authenticate, isCounselor, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
  const { studentEmail, message } = req.body;
  try {
    const docRef = await db.collection('summons').add({
      studentEmail,
      message,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    res.status(200).json({ id: docRef.id });
  } catch (error) {
    console.error('Error sending summon:', error);
    res.status(500).json({ message: 'Error sending summon' });
  }
});

// Delete a summon (Counselor only)
app.delete('/api/delete-summon/:id', authenticate, isCounselor, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Firestore not initialized' });
  const { id } = req.params;
  try {
    await db.collection('summons').doc(id).delete();
    res.status(200).json({ message: 'Summon deleted' });
  } catch (error) {
    console.error('Error deleting summon:', error);
    res.status(500).json({ message: 'Error deleting summon' });
  }
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
