interface ServiceMonitorItem {
  monitor_id: number;
  server_id: number;
  monitor_name: string;
  server_name: string;
  created_at: number[];
  avg_delay: number[];
}

export function generateChartConfig(monitorData: ServiceMonitorItem[], serverName: string): object {
  const colors = [
    "rgb(0, 255, 255)",
    "rgb(255, 99, 132)",
    "rgb(50, 205, 50)",
    "rgb(255, 215, 0)",
    "rgb(255, 105, 180)",
    "rgb(255, 165, 0)",
  ];

  if (!monitorData.length || !monitorData[0]?.created_at?.length) {
    return { type: "line", data: { labels: [], datasets: [] } };
  }

  const baseCreatedAt = monitorData[0].created_at;
  const dataLength = baseCreatedAt.length;

  const maxPoints = 200;
  const sampleIndices: number[] = [];
  if (dataLength <= maxPoints) {
    for (let i = 0; i < dataLength; i++) sampleIndices.push(i);
  } else {
    const step = (dataLength - 1) / (maxPoints - 1);
    for (let j = 0; j < maxPoints; j++) {
      sampleIndices.push(Math.round(j * step));
    }
  }

  const labels = sampleIndices.map((i) => {
    const ts = baseCreatedAt[i];
    const date = new Date(ts);
    return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  });

  const datasets = monitorData.map((item, index) => ({
    label: item.monitor_name,
    data: sampleIndices.map((i) => item.avg_delay[i] ?? null),
    borderColor: colors[index % colors.length],
    fill: false,
    pointRadius: 0,
    borderWidth: 1.5,
  }));

  return {
    type: "line",
    data: { labels, datasets },
    options: {
      title: {
        display: true,
        text: `${serverName} - Service Monitor`,
        fontColor: "#ffffff",
      },
      legend: {
        position: "bottom",
        labels: {
          fontColor: "#ffffff",
        },
      },
      scales: {
        yAxes: [{
          scaleLabel: {
            display: true,
            labelString: "Delay (ms)",
            fontColor: "#ffffff",
          },
          ticks: {
            beginAtZero: true,
            fontColor: "#cccccc",
          },
          gridLines: {
            color: "rgba(255, 255, 255, 0.2)",
          },
        }],
        xAxes: [{
          scaleLabel: {
            display: true,
            labelString: "Time",
            fontColor: "#ffffff",
          },
          ticks: {
            fontColor: "#cccccc",
          },
          gridLines: {
            color: "rgba(255, 255, 255, 0.2)",
          },
        }],
      },
    },
  };
}

