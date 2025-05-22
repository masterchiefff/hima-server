require('dotenv').config();
   const mongoose = require('mongoose');
   const Premium = require('./models/Premium');

   const premiumsData = [
     {
       id: 'basic-accident',
       name: 'Basic Accident',
       description: 'Essential coverage for accidents while riding',
       basePrice: 50,
       coverages: [
         { id: 'personal-accident', name: 'Personal Accident', included: true },
         { id: 'medical-expenses', name: 'Medical Expenses (Limited)', included: true },
         { id: 'third-party-injury', name: 'Third Party Injury', included: false },
         { id: 'bike-damage', name: 'Motorcycle Damage', included: false },
         { id: 'theft-protection', name: 'Theft Protection', included: false },
       ],
     },
     {
       id: 'comprehensive',
       name: 'Comprehensive',
       description: 'Full coverage for your motorcycle and yourself',
       basePrice: 150,
       coverages: [
         { id: 'personal-accident', name: 'Personal Accident', included: true },
         { id: 'medical-expenses', name: 'Medical Expenses (Full)', included: true },
         { id: 'third-party-injury', name: 'Third Party Injury', included: true },
         { id: 'bike-damage', name: 'Motorcycle Damage', included: true },
         { id: 'theft-protection', name: 'Theft Protection', included: true },
       ],
     },
     {
       id: 'third-party',
       name: 'Third Party',
       description: 'Coverage for damage to others and their property',
       basePrice: 75,
       coverages: [
         { id: 'personal-accident', name: 'Personal Accident', included: false },
         { id: 'medical-expenses', name: 'Medical Expenses', included: false },
         { id: 'third-party-injury', name: 'Third Party Injury', included: true },
         { id: 'bike-damage', name: 'Motorcycle Damage', included: false },
         { id: 'theft-protection', name: 'Theft Protection', included: false },
       ],
     },
   ];

   async function seedPremiums() {
     try {
       console.log('MONGO_URI:', process.env.MONGO_URI); // Debug
       if (!process.env.MONGO_URI) {
         throw new Error('MONGO_URI is not defined in .env file');
       }
       await mongoose.connect(process.env.MONGO_URI, {
         useNewUrlParser: true,
         useUnifiedTopology: true,
       });
       console.log('Connected to MongoDB');

       await Premium.deleteMany({});
       console.log('Cleared existing premiums');

       await Premium.insertMany(premiumsData);
       console.log('Seeded premiums collection');

       mongoose.connection.close();
       console.log('Disconnected from MongoDB');
     } catch (error) {
       console.error('Error seeding premiums:', error);
       mongoose.connection.close();
     }
   }

   seedPremiums();