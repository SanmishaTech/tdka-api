const createError = require('http-errors');
const aclService = require('../services/aclService');

module.exports = (permission) => async (req, res, next) => {
  try {
    console.log('ACL Check - User:', req.user?.id, 'Role:', req.user?.role, 'Required Permission:', permission);
    
    if (!req.user || !req.user.role) {
      console.log('ACL Error - User role not found');
      return next(createError(403, 'User role not found'));
    }

    // Use aclService to check if the user has the required permission
    const hasPermission = await aclService.hasPermission(req.user, permission);
    console.log('ACL Result - Has Permission:', hasPermission);

    if (hasPermission) {
      return next();
    }

    console.log('ACL Error - Insufficient permissions for user role:', req.user.role);
    return next(createError(403, 'Insufficient permissions'));
  } catch (error) {
    console.error('ACL Error:', error);
    return next(createError(500, 'Error checking permissions'));
  }
};
