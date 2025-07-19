const { ZodError } = require("zod"); // Optional: Import for instanceof checks if needed elsewhere

/**
 * Validates incoming data against a Zod schema and merges potential upload errors.
 * Reports only the *first* error encountered for each field, ensuring messages are non-empty.
 *
 * @template T
 * @param {import('zod').ZodSchema<T>} schema - The Zod schema to validate against.
 * @param {unknown} data - The data to validate (typically req.body or combined data).
 * @param {object} [uploadErrors={}] - An object containing errors related to file uploads,
 *   where keys are field names and values can be:
 *   - An array of error objects/strings (only the first valid one will be considered)
 *   - A single error object ({ type: string, message: string })
 *   - An error string
 *   - A MulterError object (or similar error object with a `message` property)
 *   - Other non-error values (like empty strings or objects) which will be ignored.
 * @returns {Promise<{success: true, data: T} | {success: false, errors: Record<string, {type: string, message: string}>}>}
 *   Returns {success: true, data: validatedData} on success,
 *   or {success: false, errors: formattedErrors} on failure, where errors object
 *   maps field names to a single error object with a non-empty message.
 */
const validateRequest = async (schema, data, uploadErrors = {}) => {
  // console.log("Validating request data:", data); // Keep for debugging if needed
  // console.log("Received uploadErrors:", uploadErrors); // Debugging upload errors

  const errors = {};

  // --- 1. Zod Schema Validation ---
  const result = await schema.safeParseAsync(data);

  if (!result.success) {
    result.error.errors.forEach((e) => {
      const name = e.path.length ? e.path.join(".") : "_error";
      if (!errors[name]) {
        // Ensure Zod message is not empty either, though typically it won't be
        if (e.message && e.message.trim() !== "") {
          errors[name] = {
            type: "server",
            message: e.message,
          };
        } else {
          console.warn(
            `Zod reported an empty error message for path '${name}'. Skipping.`
          );
        }
      }
    });
  }

  // --- 2. Process and Merge Upload Errors (only if no Zod error exists for the field) ---
  if (
    uploadErrors &&
    typeof uploadErrors === "object" &&
    Object.keys(uploadErrors).length > 0
  ) {
    Object.entries(uploadErrors).forEach(([field, errorValue]) => {
      // Skip if a Zod error already exists for this field
      if (errors[field]) {
        return;
      }

      let firstUploadError = null; // Store the first potential upload error found

      // --- Try to extract a meaningful error message ---

      if (Array.isArray(errorValue)) {
        for (const err of errorValue) {
          if (
            err &&
            typeof err === "object" &&
            typeof err.message === "string" &&
            err.message.trim() !== ""
          ) {
            firstUploadError = {
              type: err.type || "upload_error",
              message: err.message.trim(),
            };
            break;
          } else if (typeof err === "string" && err.trim() !== "") {
            firstUploadError = { type: "upload_error", message: err.trim() };
            break;
          }
        }
      } else if (errorValue && typeof errorValue === "object") {
        // Handle specific error objects like MulterError or custom ones
        if (
          typeof errorValue.message === "string" &&
          errorValue.message.trim() !== ""
        ) {
          firstUploadError = {
            type: errorValue.code || errorValue.type || "upload_error",
            message: errorValue.message.trim(),
          };
        }
        // Ignore objects without a non-empty 'message' string (like {}, { message: '' }, etc.)
      } else if (typeof errorValue === "string" && errorValue.trim() !== "") {
        // Handle simple error strings, ignoring empty ones
        firstUploadError = {
          type: "upload_error", // Simple string, likely indicates an upload issue
          message: errorValue.trim(),
        };
      }
      // Ignore other types (null, undefined, numbers, empty strings, empty objects) for this field

      // --- Add the error if found and meaningful ---
      // If we found a valid upload error object *and* its message is confirmed non-empty
      // (already checked during creation above), add it.
      if (firstUploadError /* implicitly also checks !errors[field] */) {
        errors[field] = firstUploadError;
      }
    });
  }

  // --- 3. Determine Final Outcome ---
  const hasErrors = Object.keys(errors).length > 0;

  if (hasErrors) {
    // console.error("Validation Failed. Errors:", JSON.stringify(errors, null, 2));
    return { success: false, errors };
  }

  // Success case (only if Zod passed AND no *meaningful* upload errors were added)
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    // Safety net: Zod failed, but somehow no errors were recorded (e.g., all Zod messages were empty)
    console.error(
      "Internal validation logic inconsistency: Zod failed but no non-empty errors recorded."
    );
    return {
      success: false,
      errors: {
        _error: {
          type: "internal_error",
          message: "Validation failed unexpectedly.",
        },
      },
    };
  }
};

module.exports = validateRequest;
