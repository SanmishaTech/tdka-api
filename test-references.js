// Test script for References model
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testReferences() {
  try {
    console.log('Testing Reference and Member relationship...');

    // Check if Zone with ID 1 exists
    let zone = await prisma.zone.findUnique({
      where: { id: 1 }
    });

    // If not, create a zone
    if (!zone) {
      zone = await prisma.zone.create({
        data: {
          name: 'Test Zone',
          active: true
        }
      });
      console.log('Created test zone:', zone);
    }

    // Check if Location with ID 1 exists
    let location = await prisma.location.findUnique({
      where: { id: 1 }
    });

    // If not, create a location
    if (!location) {
      location = await prisma.location.create({
        data: {
          zoneId: zone.id,
          location: 'Test Location'
        }
      });
      console.log('Created test location:', location);
    }

    // First, let's create a test Chapter
    const chapter = await prisma.chapter.create({
      data: {
        name: 'Test Chapter',
        zoneId: zone.id,
        locationId: location.id,
        date: new Date(),
        meetingday: 'Monday',
        venue: 'Test Venue',
        status: true
      }
    });
    
    console.log('Created test chapter:', chapter);

    // Create two test Members
    const member1 = await prisma.member.create({
      data: {
        memberName: 'Giver Member',
        category: 'Test',
        businessCategory: 'Test',
        gender: 'Male',
        dateOfBirth: new Date('1990-01-01'),
        mobile1: '1234567890',
        organizationName: 'Test Org',
        organizationMobileNo: '1234567890',
        orgAddressLine1: 'Test Address',
        orgLocation: 'Test Location',
        orgPincode: '123456',
        addressLine1: 'Test Address',
        location: 'Test Location',
        pincode: '123456',
        email: 'giver@test.com',
        password: 'password',
        chapterId: chapter.id
      }
    });

    const member2 = await prisma.member.create({
      data: {
        memberName: 'Receiver Member',
        category: 'Test',
        businessCategory: 'Test',
        gender: 'Female',
        dateOfBirth: new Date('1990-01-01'),
        mobile1: '0987654321',
        organizationName: 'Test Org 2',
        organizationMobileNo: '0987654321',
        orgAddressLine1: 'Test Address 2',
        orgLocation: 'Test Location 2',
        orgPincode: '654321',
        addressLine1: 'Test Address 2',
        location: 'Test Location 2',
        pincode: '654321',
        email: 'receiver@test.com',
        password: 'password',
        chapterId: chapter.id
      }
    });

    console.log('Created test members:', member1.id, member2.id);

    // Now create a reference
    const reference = await prisma.reference.create({
      data: {
        date: new Date(),
        chapterId: chapter.id,
        giverId: member1.id,
        receiverId: member2.id,
        nameOfReferral: 'Test Referral',
        mobile1: '1122334455',
        status: 'pending'
      }
    });

    console.log('Created reference:', reference);

    // Now test fetching the reference with the giver and receiver
    const fetchedReference = await prisma.reference.findUnique({
      where: { id: reference.id },
      include: {
        giver: true,
        receiver: true
      }
    });

    console.log('Fetched reference with relations:');
    console.log('- Giver ID:', fetchedReference.giverId);
    console.log('- Giver:', fetchedReference.giver ? fetchedReference.giver.memberName : 'NULL');
    console.log('- Receiver ID:', fetchedReference.receiverId);
    console.log('- Receiver:', fetchedReference.receiver ? fetchedReference.receiver.memberName : 'NULL');

    // Cleanup
    await prisma.reference.delete({ where: { id: reference.id } });
    await prisma.member.delete({ where: { id: member1.id } });
    await prisma.member.delete({ where: { id: member2.id } });
    await prisma.chapter.delete({ where: { id: chapter.id } });
    
    // Clean up zone and location if we created them
    // Only clean up if we created them in this script
    if (!location) {
      await prisma.location.delete({ where: { id: location.id } });
    }
    if (!zone) {
      await prisma.zone.delete({ where: { id: zone.id } });
    }

    console.log('Test completed and data cleaned up.');
  } catch (error) {
    console.error('Test failed with error:', error);
    // Print full error stack
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

testReferences().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
}); 