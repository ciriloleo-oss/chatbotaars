  } catch (error) {
    console.error("Erro ao enviar WhatsApp:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    throw error;
  }