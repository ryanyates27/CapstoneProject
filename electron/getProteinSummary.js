/**
 * Fetches a protein function summary from the UniProt API for a given FlyBase gene ID.
 * @param {string} flybaseId - The FlyBase gene ID (i.e. "FBgn0040070")
 * @returns {string} - String of the protein function summary and UniProt ID
 * @throws {Error} - Throws error if ID invalid, network error, API error, or JSON parsing error
 */
async function getProteinSummary(flybaseId) {
    if (!flybaseId || typeof flybaseId !== "string") {
        throw new Error("Invalid FlyBase gene ID given.");
    }

    const url = `https://www.ebi.ac.uk/proteins/api/proteins/flybase:${flybaseId}?offset=0&size=100`;

    let response;
    try {
        response = await fetch(url, {
        headers: { Accept: "application/json" }
    });
    } catch (networkError) {
        throw new Error(`Network error: ${networkError.message}`);
    }

    if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    let data;
    try {
        data = await response.json();
    } catch (parseError) {
        throw new Error("Failed parsing as JSON");
    }

    // nothing found
    if (!Array.isArray(data) || data.length === 0) {
        return "No proteins found for this FlyBase ID.";
    }

    // get the first protein entry
    const protein = data[0];

    // get protein id
    const proteinId = protein.accession || "Unknown";

    // get the function summary
    let summary = "No function summary available.";
    if (protein.comments) {
        const func = protein.comments.find(c => c.type === "FUNCTION");
        if (func && func.text) {
            summary = func.text.map(t => t.value).join(" ");
        }
    }

    // return single string
    return `${summary}\n(UniProt, ${proteinId})`;
}


// example usage
/*
(async () => {
    try {
        const summary = await getProteinSummary("FBgn0040070");
        console.log(summary);
    } catch (err) {
        console.error("Error:", err.message);
    }
})();
*/

