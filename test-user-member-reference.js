// Test script for User-Member-Reference relationship
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testUserMemberReferenceRelationship() {
  try {
    console.log('Testing User-Member-Reference relationship...');

    // Create a test zone and location if needed
    const zone = await prisma.zone.upsert({
      where: { id: 1 },
      update: {},
      create: {
        name: 'Test Zone',
        active: true
      }
    });

    const location = await prisma.location.upsert({
      where: { id: 1 },
      update: {},
      create: {
        zoneId: zone.id,
        location: 'Test Location'
      }
    });

    // Create a test chapter
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
    
    console.log('Created test chapter:', chapter.id);

    // 1. Create a User
    const user = await prisma.user.create({
      data: {
        name: 'Test User',
        email: 'user@test.com',
        password: 'password',
        role: 'user'
      }
    });
    
    console.log('Created test user:', user.id);

    // 2. Create a Member linked to the User
    const member = await prisma.member.create({
      data: {
        memberName: 'Test Member',
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
        email: 'member@test.com',
        password: 'password',
        chapterId: chapter.id,
        userId: user.id // Link to the user
      }
    });
    
    console.log('Created test member linked to user:', member.id);

    // Check if Member was properly linked to User
    const memberWithUser = await prisma.member.findUnique({
      where: { id: member.id },
      include: { users: true }
    });
    
    console.log('Member-User relationship:');
    console.log('- Member ID:', memberWithUser.id);
    console.log('- User link exists:', memberWithUser.users !== null);
    if (memberWithUser.users) {
      console.log('- Linked User ID:', memberWithUser.users.id);
    }

    // Create a second member (receiver)
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

    console.log('Created receiver member:', member2.id);

    // 3. Create a Reference with the Member as giver
    const reference = await prisma.reference.create({
      data: {
        date: new Date(),
        chapterId: chapter.id,
        giverId: member.id, // User from member record
        receiverId: member2.id,
        nameOfReferral: 'Test Referral',
        mobile1: '1122334455',
        status: 'pending'
      }
    });
    
    console.log('Created reference with member as giver:', reference.id);

    // 4. Attempt to fetch the reference with all relationships
    const fetchedReference = await prisma.reference.findUnique({
      where: { id: reference.id },
      include: {
        giver: {
          include: {
            users: true
          }
        },
        receiver: true
      }
    });
    
    console.log('Fetched reference with relations:');
    console.log('- Reference ID:', fetchedReference.id);
    console.log('- Giver ID:', fetchedReference.giverId);
    console.log('- Giver Name:', fetchedReference.giver.memberName);
    console.log('- Giver User ID:', fetchedReference.giver.userId);
    console.log('- Receiver ID:', fetchedReference.receiverId);
    console.log('- Receiver Name:', fetchedReference.receiver.memberName);

    // Cleanup
    await prisma.reference.delete({ where: { id: reference.id } });
    await prisma.member.delete({ where: { id: member2.id } });
    await prisma.member.delete({ where: { id: member.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.chapter.delete({ where: { id: chapter.id } });

    console.log('Test completed and data cleaned up.');
  } catch (error) {
    console.error('Test failed with error:', error);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

testUserMemberReferenceRelationship().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
}); 