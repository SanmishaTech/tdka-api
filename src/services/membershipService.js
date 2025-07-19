const prisma = require("../config/db");

/**
 * Checks member's HO and venue expiry dates and determines if membership is active
 * @param {number} userId - User ID to check
 * @returns {Object} Object containing active status and expiry info
 */
const checkMembershipExpiry = async (userId) => {
  try {
    // Find the member record associated with user
    const member = await prisma.member.findFirst({
      where: { userId: userId }
    });

    // If no member record exists, return active status as true with no expiry information
    if (!member) {
      return { 
        active: true, 
        expiryInfo: null 
      };
    }

    const now = new Date();
    const hoExpired = member.hoExpiryDate ? member.hoExpiryDate < now : false;
    const venueExpired = member.venueExpiryDate ? member.venueExpiryDate < now : false;
    
    // Determine the earlier expiry date
    let earlierExpiryDate = null;
    let expiryType = null;
    
    if (member.hoExpiryDate && member.venueExpiryDate) {
      if (member.hoExpiryDate < member.venueExpiryDate) {
        earlierExpiryDate = member.hoExpiryDate;
        expiryType = 'HO';
      } else {
        earlierExpiryDate = member.venueExpiryDate;
        expiryType = 'Venue';
      }
    } else if (member.hoExpiryDate) {
      earlierExpiryDate = member.hoExpiryDate;
      expiryType = 'HO';
    } else if (member.venueExpiryDate) {
      earlierExpiryDate = member.venueExpiryDate;
      expiryType = 'Venue';
    }

    // If either HO or venue has expired, set active to false
    const active = !(hoExpired || venueExpired);
    
    // If the member is inactive, update the user's active status
    if (!active) {
      await prisma.user.update({
        where: { id: userId },
        data: { active: false }
      });
    }

    return {
      active,
      expiryInfo: {
        hoExpired,
        venueExpired,
        earlierExpiryDate,
        expiryType,
        memberId: member.id
      }
    };
  } catch (error) {
    console.error("Error checking membership expiry:", error);
    // In case of error, return active to avoid blocking login
    return { active: true, expiryInfo: null, error: error.message };
  }
};

/**
 * Check if a member has any active memberships
 * @param {number} memberId - Member ID to check
 * @returns {boolean} True if member has at least one active membership
 */
const hasMembership = async (memberId) => {
  try {
    const count = await prisma.membership.count({
      where: {
        memberId: memberId,
        active: true,
        packageEndDate: {
          gte: new Date()
        }
      }
    });
    
    return count > 0;
  } catch (error) {
    console.error("Error checking memberships:", error);
    return false;
  }
};

module.exports = {
  checkMembershipExpiry,
  hasMembership
};
