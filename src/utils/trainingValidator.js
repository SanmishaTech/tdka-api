/**
 * Training-specific validator that handles Zod validation with proper error handling
 * @param {Object} schema - Zod schema to validate against
 * @param {Object} data - Data to validate
 * @param {Object} res - Express response object
 * @returns {Promise<Object|null>} - Returns validated data or null if validation failed
 */
const validateTraining = async (schema, data, res) => {
  try {
    // Directly parse and return the result
    const result = await schema.safeParseAsync(data);
    
    if (!result.success) {
      // Format errors in a consistent way
      const errors = {};
      
      result.error.errors.forEach((e) => {
        const name = e.path.length ? e.path.join(".") : "_error";
        errors[name] = {
          type: "server",
          message: e.message,
        };
      });
      
      // Send the error response
      res.status(400).json({ errors });
      return null;
    }
    
    // Return the validated data
    return result.data;
  } catch (error) {
    // Handle any unexpected errors
    console.error("Training validation error:", error);
    res.status(500).json({ 
      errors: { 
        message: "Server error during validation",
        details: error.message 
      } 
    });
    return null;
  }
};

module.exports = validateTraining; 